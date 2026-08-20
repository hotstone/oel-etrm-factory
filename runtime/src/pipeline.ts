import { TextBlock } from "@strands-agents/sdk";
import { Graph, Node } from "@strands-agents/sdk/multiagent";
import type {
  MultiAgentInput,
  MultiAgentState,
  MultiAgentStreamEvent,
  NodeInputOptions,
} from "@strands-agents/sdk/multiagent";
import {
  AssessmentSchema,
  CritiqueSchema,
  analyzerPrompt,
  antagonistPrompt,
  makeAnalyzer,
  makeAntagonist,
  type Assessment,
  type Critique,
} from "./agents.js";
import { runClaudePlanning } from "./claude.js";
import { runExecutorBuild, type ExecutorRun } from "./codebuild.js";
import { CONFIG } from "./config.js";
import { commentOnPr, fetchPrDiff } from "./github.js";
import { commentOnIssue, fetchIssue, setAgentLabel, type LinearIssue } from "./linear.js";
import { cloneWorkspace, removeWorkspace } from "./workspace.js";

/**
 * Mutable per-run context shared across nodes via closure. The graph provides
 * ordering, gating, timeouts, and observability; data flows through here.
 *
 * NOTE on loops: the TS Strands Graph uses AND-dependency semantics, so cyclic
 * feedback edges (critique→plan, review→implement) would deadlock the first
 * execution. The plan⇄antagonist and review⇄revision loops therefore run
 * imperatively *inside* the plan and review nodes, with hard iteration caps.
 */
interface RunContext {
  issue: LinearIssue;
  workspace?: string;
  assessment?: Assessment;
  plan?: string;
  planSessionId?: string;
  critiques: Critique[];
  executorRun?: ExecutorRun;
  reviewFindings?: string[];
  revisionRuns: number;
}

export interface PipelineOutcome {
  status: "completed" | "blocked" | "failed";
  issue: string;
  detail: string;
  prUrl?: string;
}

type NodeGen = AsyncGenerator<MultiAgentStreamEvent, { content: TextBlock[] }, undefined>;

/** Custom node wrapping an async function; content is for trace/observability. */
class StepNode extends Node {
  constructor(
    id: string,
    private readonly fn: () => Promise<string>,
  ) {
    super(id, {});
  }
  // eslint-disable-next-line require-yield
  async *handle(_input: MultiAgentInput, _state: MultiAgentState, _options?: NodeInputOptions): NodeGen {
    const summary = await this.fn();
    return { content: [new TextBlock(summary)] };
  }
}

const PLAN_PROMPT_HEADER = `You are planning an implementation in this repository — do not write any code.
Explore the codebase (CLAUDE.md, the files the ticket concerns, their tests), then produce
an implementation plan in markdown with sections: Problem, Changes (numbered, per file,
specific), Out of scope, Verification. The plan will be executed by another engineer who
has only your plan and the repo — name real files, functions, and test commands.`;

export async function runPipeline(issueIdentifier: string): Promise<PipelineOutcome> {
  const issue = await fetchIssue(issueIdentifier);
  const ctx: RunContext = { issue, critiques: [], revisionRuns: 0 };
  const analyzer = makeAnalyzer();
  const antagonist = makeAntagonist();

  const analyzeNode = new StepNode("analyze", async () => {
    const result = await analyzer.invoke(analyzerPrompt(ctx.issue));
    ctx.assessment = AssessmentSchema.parse(result.structuredOutput);
    return JSON.stringify(ctx.assessment);
  });

  const planNode = new StepNode("plan", async () => {
    ctx.workspace = await cloneWorkspace();
    const assessment = ctx.assessment!;
    const criteria = assessment.acceptanceCriteria.map((c) => `- ${c}`).join("\n");

    const first = await runClaudePlanning(
      ctx.workspace,
      `${PLAN_PROMPT_HEADER}

# Ticket ${ctx.issue.identifier}: ${ctx.issue.title}

${ctx.issue.description}

## Acceptance criteria
${criteria}`,
    );
    ctx.plan = first.text;
    ctx.planSessionId = first.sessionId;

    for (let i = 0; i < CONFIG.limits.critiqueIterations; i++) {
      const critiqueResult = await antagonist.invoke(antagonistPrompt(assessment, ctx.plan));
      const critique = CritiqueSchema.parse(critiqueResult.structuredOutput);
      ctx.critiques.push(critique);
      const blocking = critique.objections.filter((o) => o.severity === "blocking");
      if (critique.approved || blocking.length === 0) break;

      const revised = await runClaudePlanning(
        ctx.workspace,
        `A reviewer raised these blocking objections to your plan:
${blocking.map((o) => `- ${o.objection}`).join("\n")}

Revise the plan to address them. Output the full revised plan in the same format.`,
        ctx.planSessionId,
      );
      ctx.plan = revised.text;
      ctx.planSessionId = revised.sessionId;
    }
    return ctx.plan;
  });

  const implementNode = new StepNode("implement", async () => {
    ctx.executorRun = await runExecutorBuild({
      issueId: ctx.issue.identifier,
      issueTitle: ctx.issue.title,
      issueUrl: ctx.issue.url,
      plan: ctx.plan!,
      runLabel: "initial",
    });
    return ctx.executorRun.prUrl;
  });

  const reviewNode = new StepNode("review", async () => {
    for (;;) {
      const diff = await fetchPrDiff(ctx.executorRun!.prNumber);
      const review = await runClaudePlanning(
        ctx.workspace!,
        `You are reviewing a pull request diff against ticket ${ctx.issue.identifier} and its plan.
Read any repository context you need. Report every mismatch with the plan or acceptance
criteria, and every correctness bug in the diff. Do not comment on style. Output markdown:
a "## Findings" section with one bullet per finding prefixed [blocking] or [minor], or the
exact text "No findings." if clean.

## Acceptance criteria
${ctx.assessment!.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

## Plan
${ctx.plan!}

## Diff
\`\`\`diff
${diff}
\`\`\``,
      );

      const blocking = review.text
        .split("\n")
        .filter((l) => l.toLowerCase().includes("[blocking]"));
      ctx.reviewFindings = blocking;
      if (blocking.length === 0) return "clean";
      if (ctx.revisionRuns >= CONFIG.limits.reviewIterations) {
        // Cap hit: surface the findings on the PR for the human reviewer.
        await commentOnPr(
          ctx.executorRun!.prNumber,
          `**Agent review — unresolved findings** (revision cap reached; human attention needed):\n\n${review.text}`,
        );
        return `cap-hit: ${blocking.length} unresolved finding(s) posted to PR`;
      }
      ctx.revisionRuns++;
      ctx.executorRun = await runExecutorBuild({
        issueId: ctx.issue.identifier,
        issueTitle: ctx.issue.title,
        issueUrl: ctx.issue.url,
        plan: `# Revision ${ctx.revisionRuns} for ${ctx.issue.identifier}

A code review of the current branch found these blocking issues:
${blocking.map((b) => `- ${b}`).join("\n")}

Fix them on top of the existing implementation. Original plan for reference:

${ctx.plan!}`,
        runLabel: `revision-${ctx.revisionRuns}`,
      });
    }
  });

  const graph = new Graph({
    id: `pipeline-${issue.identifier}`,
    nodes: [analyzeNode, planNode, implementNode, reviewNode],
    edges: [
      { source: "analyze", target: "plan", handler: () => ctx.assessment?.suitable === true },
      { source: "plan", target: "implement", handler: () => Boolean(ctx.plan) },
      ["implement", "review"],
    ],
    maxSteps: 10,
    timeout: CONFIG.limits.graphTimeoutMs,
  });

  await setAgentLabel(issue.id, "agentInProgress");
  try {
    const result = await graph.invoke(`Deliver ticket ${issue.identifier}`);

    if (ctx.assessment && !ctx.assessment.suitable) {
      const questions = ctx.assessment.missingInfo.map((q) => `- ${q}`).join("\n");
      await commentOnIssue(
        issue.id,
        `**Agent: not picking this up yet.** The ticket needs clarification before automated implementation:\n\n${questions || "- The request is too vague to derive testable acceptance criteria."}\n\nAnswer above and re-apply the \`agent-ready\` label to retry.`,
      );
      await setAgentLabel(issue.id, "agentBlocked");
      return { status: "blocked", issue: issue.identifier, detail: "analyzer gate: not suitable" };
    }

    if (result.status !== "COMPLETED" || !ctx.executorRun) {
      throw new Error(`graph finished with status ${result.status}`);
    }

    const findingsNote = ctx.reviewFindings?.length
      ? ` Review left ${ctx.reviewFindings.length} unresolved finding(s) — see PR comments.`
      : " Agent review found no blocking issues.";
    await commentOnIssue(
      issue.id,
      `**Agent: PR ready for review.** ${ctx.executorRun.prUrl}${findingsNote}`,
    );
    await setAgentLabel(issue.id, null);
    return {
      status: "completed",
      issue: issue.identifier,
      detail: findingsNote.trim(),
      prUrl: ctx.executorRun.prUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await commentOnIssue(issue.id, `**Agent: pipeline failed.** ${message}`).catch(() => {});
    await setAgentLabel(issue.id, "agentBlocked").catch(() => {});
    return { status: "failed", issue: issue.identifier, detail: message };
  } finally {
    if (ctx.workspace) await removeWorkspace(ctx.workspace).catch(() => {});
  }
}

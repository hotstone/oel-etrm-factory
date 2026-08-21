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
  adversaryPrompt,
  makeAnalyzer,
  makeAdversary,
  type Assessment,
  type Critique,
} from "./agents.js";
import { runClaudePlanning } from "./claude.js";
import { runExecutorBuild, type ExecutorRun } from "./codebuild.js";
import { CONFIG } from "./config.js";
import { commentOnPr, fetchPrDiff } from "./github.js";
import { commentOnIssue, fetchIssue, setAgentLabel, type LinearIssue } from "./linear.js";
import { emitRunMetrics, type StageStat } from "./metrics.js";
import { withSpan } from "./telemetry.js";
import { cloneWorkspace, removeWorkspace } from "./workspace.js";

/**
 * Mutable per-run context shared across nodes via closure. The graph provides
 * ordering, gating, timeouts, and observability; data flows through here.
 *
 * NOTE on loops: the TS Strands Graph uses AND-dependency semantics, so cyclic
 * feedback edges (critique→plan, review→implement) would deadlock the first
 * execution. The plan⇄adversary and review⇄revision loops therefore run
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

interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface StepOutput {
  summary: string;
  usage?: StepUsage;
}

function usageOf(input: number, output: number): StepUsage {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

type NodeGen = AsyncGenerator<MultiAgentStreamEvent, { content: TextBlock[]; usage?: StepUsage }, undefined>;

/** Custom node wrapping an async function; content/usage feed traces + metrics. */
class StepNode extends Node {
  constructor(
    id: string,
    private readonly fn: () => Promise<StepOutput>,
  ) {
    super(id, {});
  }
  // eslint-disable-next-line require-yield
  async *handle(_input: MultiAgentInput, _state: MultiAgentState, _options?: NodeInputOptions): NodeGen {
    const out = await withSpan(`pipeline.${this.id}`, { "node.id": this.id }, this.fn);
    return { content: [new TextBlock(out.summary)], usage: out.usage };
  }
}

const PLAN_PROMPT_HEADER = `You are planning an implementation in this repository — do not write any code.
Explore the codebase (CLAUDE.md, the files the ticket concerns, their tests), then produce
an implementation plan in markdown with sections: Problem, Changes (numbered, per file,
specific), Out of scope, Verification. The plan will be executed by another engineer who
has only your plan and the repo — name real files, functions, and test commands.`;

function stagesFrom(results: { nodeId: string; duration: number; usage?: { inputTokens: number; outputTokens: number } }[]): StageStat[] {
  return results.map((r) => ({
    stage: r.nodeId,
    durationMs: Math.round(r.duration),
    ...(r.usage ? { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } : {}),
  }));
}

export async function runPipeline(issueIdentifier: string): Promise<PipelineOutcome> {
  const runStart = Date.now();
  let stages: StageStat[] = [];
  const issue = await fetchIssue(issueIdentifier);
  const ctx: RunContext = { issue, critiques: [], revisionRuns: 0 };
  const analyzer = makeAnalyzer();
  const adversary = makeAdversary();

  const analyzeNode = new StepNode("analyze", async () => {
    const result = await analyzer.invoke(analyzerPrompt(ctx.issue));
    ctx.assessment = AssessmentSchema.parse(result.structuredOutput);
    const u = result.metrics?.accumulatedUsage;
    return {
      summary: JSON.stringify(ctx.assessment),
      usage: u ? usageOf(u.inputTokens, u.outputTokens) : undefined,
    };
  });

  const planNode = new StepNode("plan", async () => {
    let inTok = 0;
    let outTok = 0;
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
    inTok += first.inputTokens;
    outTok += first.outputTokens;

    for (let i = 0; i < CONFIG.limits.critiqueIterations; i++) {
      const critiqueResult = await adversary.invoke(adversaryPrompt(assessment, ctx.plan));
      const cu = critiqueResult.metrics?.accumulatedUsage;
      if (cu) {
        inTok += cu.inputTokens;
        outTok += cu.outputTokens;
      }
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
      inTok += revised.inputTokens;
      outTok += revised.outputTokens;
    }
    return { summary: ctx.plan, usage: usageOf(inTok, outTok) };
  });

  const implementNode = new StepNode("implement", async () => {
    ctx.executorRun = await runExecutorBuild({
      issueId: ctx.issue.identifier,
      issueTitle: ctx.issue.title,
      issueUrl: ctx.issue.url,
      plan: ctx.plan!,
      runLabel: "initial",
    });
    return { summary: ctx.executorRun.prUrl };
  });

  const reviewNode = new StepNode("review", async () => {
    let inTok = 0;
    let outTok = 0;
    for (;;) {
      const diff = await fetchPrDiff(ctx.executorRun!.prNumber);
      const review = await runClaudePlanning(
        ctx.workspace!,
        `You are reviewing a pull request diff against ticket ${ctx.issue.identifier} and its plan.
Read any repository context you need. Report every mismatch with the plan or acceptance
criteria, and every correctness bug in the diff. Do not comment on style. Your entire
output must be ONLY a "## Findings" section with one bullet per finding prefixed
[blocking] or [minor], or the exact text "No findings." if clean. No preamble, no
narration of your process, no verification walkthrough — the output is posted verbatim
to the pull request.

## Acceptance criteria
${ctx.assessment!.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

## Plan
${ctx.plan!}

## Diff
\`\`\`diff
${diff}
\`\`\``,
      );

      inTok += review.inputTokens;
      outTok += review.outputTokens;
      const blocking = review.text
        .split("\n")
        .filter((l) => l.toLowerCase().includes("[blocking]"));
      ctx.reviewFindings = blocking;
      if (blocking.length === 0) return { summary: "clean", usage: usageOf(inTok, outTok) };
      if (ctx.revisionRuns >= CONFIG.limits.reviewIterations) {
        // Cap hit: surface the findings on the PR for the human reviewer.
        await commentOnPr(
          ctx.executorRun!.prNumber,
          `**Agent review — unresolved findings** (revision cap reached; human attention needed):\n\n${review.text}`,
        );
        return {
          summary: `cap-hit: ${blocking.length} unresolved finding(s) posted to PR`,
          usage: usageOf(inTok, outTok),
        };
      }
      ctx.revisionRuns++;
      ctx.executorRun = await runExecutorBuild({
        issueId: ctx.issue.identifier,
        issueTitle: ctx.issue.title,
        issueUrl: ctx.issue.url,
        plan: `# Revision ${ctx.revisionRuns} for ${ctx.issue.identifier}

A code review of the current branch found these blocking issues:
${blocking.map((b) => `- ${b}`).join("\n")}

Fix them on top of the existing implementation. If, after investigating, you
conclude a finding is wrong and no change is needed, make no changes at all.
Original plan for reference:

${ctx.plan!}`,
        runLabel: `revision-${ctx.revisionRuns}`,
      });
      if (ctx.executorRun.agentResult === "no-changes") {
        // Implementer investigated and disagrees with the review — a judgment
        // call for the human, not a failure.
        await commentOnPr(
          ctx.executorRun.prNumber,
          `**Agent disagreement — human judgment needed.** The reviewer raised blocking findings, but the revision run concluded no change is warranted:\n\n${review.text}`,
        );
        return {
          summary: `disagreement: implementer declined ${blocking.length} finding(s); posted to PR`,
          usage: usageOf(inTok, outTok),
        };
      }
    }
  });

  const graph = new Graph({
    id: `pipeline-${issue.identifier}`,
    traceAttributes: { "issue.id": issue.identifier, "gen_ai.conversation.id": issue.identifier },
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
    stages = stagesFrom(result.results);

    if (ctx.assessment && !ctx.assessment.suitable) {
      const questions = ctx.assessment.missingInfo.map((q) => `- ${q}`).join("\n");
      await commentOnIssue(
        issue.id,
        `**Agent: not picking this up yet.** The ticket needs clarification before automated implementation:\n\n${questions || "- The request is too vague to derive testable acceptance criteria."}\n\nAnswer above and re-apply the \`agent-ready\` label to retry.`,
      );
      await setAgentLabel(issue.id, "agentBlocked");
      const outcome: PipelineOutcome = { status: "blocked", issue: issue.identifier, detail: "analyzer gate: not suitable" };
      emitRunMetrics({ issue: issue.identifier, outcome: "blocked", durationMs: Date.now() - runStart, stages, critiqueIterations: ctx.critiques.length, revisionRuns: ctx.revisionRuns, detail: outcome.detail });
      return outcome;
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
    const outcome: PipelineOutcome = {
      status: "completed",
      issue: issue.identifier,
      detail: findingsNote.trim(),
      prUrl: ctx.executorRun.prUrl,
    };
    emitRunMetrics({ issue: issue.identifier, outcome: "completed", durationMs: Date.now() - runStart, stages, critiqueIterations: ctx.critiques.length, revisionRuns: ctx.revisionRuns, prUrl: outcome.prUrl, detail: outcome.detail });
    return outcome;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 600);
    await commentOnIssue(issue.id, `**Agent: pipeline failed.** ${message}`).catch(() => {});
    await setAgentLabel(issue.id, "agentBlocked").catch(() => {});
    emitRunMetrics({ issue: issue.identifier, outcome: "failed", durationMs: Date.now() - runStart, stages, critiqueIterations: ctx.critiques.length, revisionRuns: ctx.revisionRuns, detail: message });
    return { status: "failed", issue: issue.identifier, detail: message };
  } finally {
    if (ctx.workspace) await removeWorkspace(ctx.workspace).catch(() => {});
  }
}

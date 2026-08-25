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
import { COMMENT_PREFIX } from "./comments.js";
import { runExecutorBuild, type ExecutorRun } from "./codebuild.js";
import { CONFIG } from "./config.js";
import { CuratorSchema, curatorPrompt, makeCurator } from "./curator.js";
import { parseFindings, persistCritiques, persistFindings, resolveReview, type Finding, type ReviewResolution } from "./findings.js";
import { commentOnPr, fetchPrDiff, fetchPrFiles, submitPrReview } from "./github.js";
import { lessonsBlock, reinforceLesson, retrieveLessons, writeLesson } from "./memory.js";
import { commentOnIssue, fetchIssue, setAgentLabel, type LinearIssue } from "./linear.js";
import { emitRunMetrics, type StageStat } from "./metrics.js";
import { protectedViolations, resolveTarget } from "./targets.js";
import { withSpan } from "./telemetry.js";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "./untrusted.js";
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
class BudgetExceededError extends Error {}

interface RunContext {
  tokensUsed: number;
  issue: LinearIssue;
  workspace?: string;
  assessment?: Assessment;
  plan?: string;
  planSessionId?: string;
  critiques: Critique[];
  executorRun?: ExecutorRun;
  reviewFindings?: string[];
  reviewPasses: { pass: number; prNumber: string; files: string[]; findings: Finding[] }[];
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
    console.log(`[stage:${this.id}] ${out.summary.slice(0, 300).replace(/\n/g, " ")}`);
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
  const target = resolveTarget(issue.labelIds);
  console.log(`[target] ${issue.identifier} → ${target.slug} (workdir ${target.workdir})`);
  const ctx: RunContext = { tokensUsed: 0, issue, critiques: [], reviewPasses: [], revisionRuns: 0 };
  const spend = (input: number, output: number) => {
    ctx.tokensUsed += input + output;
  };
  const assertBudget = (about: string) => {
    if (ctx.tokensUsed > CONFIG.limits.maxRunTokens) {
      throw new BudgetExceededError(
        `token budget exceeded before ${about}: ${ctx.tokensUsed} > ${CONFIG.limits.maxRunTokens}`,
      );
    }
  };
  const analyzer = makeAnalyzer();
  const adversary = makeAdversary();

  const analyzeNode = new StepNode("analyze", async () => {
    const result = await analyzer.invoke(analyzerPrompt(ctx.issue));
    ctx.assessment = AssessmentSchema.parse(result.structuredOutput);
    const u = result.metrics?.accumulatedUsage;
    if (u) spend(u.inputTokens, u.outputTokens);
    return {
      summary: JSON.stringify(ctx.assessment),
      usage: u ? usageOf(u.inputTokens, u.outputTokens) : undefined,
    };
  });

  const planNode = new StepNode("plan", async () => {
    let inTok = 0;
    let outTok = 0;
    ctx.workspace = await cloneWorkspace(target.slug);
    const assessment = ctx.assessment!;
    const criteria = assessment.acceptanceCriteria.map((c) => `- ${c}`).join("\n");

    const planLessons = await retrieveLessons(
      target.memoryNamespace,
      `${ctx.issue.title}\n${assessment.intent}\n${ctx.issue.description}\n${assessment.affectedAreas.join(" ")}`,
    );
    const deps = assessment.dependencies.length
      ? `\n\n## Dependencies\n${assessment.dependencies.map((d) => `- ${d}`).join("\n")}`
      : "";
    const first = await runClaudePlanning(
      ctx.workspace,
      `${PLAN_PROMPT_HEADER}

${UNTRUSTED_NOTICE}

${wrapUntrusted(`# Ticket ${ctx.issue.identifier}: ${ctx.issue.title}\n\n${ctx.issue.description}`)}

## Intent
${assessment.intent}

## Requirements
${assessment.requirements.map((r) => `- ${r}`).join("\n")}

## Acceptance criteria
${criteria}${deps}${lessonsBlock(planLessons)}`,
    );
    ctx.plan = first.text;
    ctx.planSessionId = first.sessionId;
    inTok += first.inputTokens;
    outTok += first.outputTokens;
    spend(first.inputTokens, first.outputTokens);

    for (let i = 0; i < CONFIG.limits.critiqueIterations; i++) {
      const critiqueResult = await adversary.invoke(adversaryPrompt(assessment, ctx.plan));
      const cu = critiqueResult.metrics?.accumulatedUsage;
      if (cu) {
        inTok += cu.inputTokens;
        outTok += cu.outputTokens;
        spend(cu.inputTokens, cu.outputTokens);
      }
      const critique = CritiqueSchema.parse(critiqueResult.structuredOutput);
      ctx.critiques.push(critique);
      const blocking = critique.objections.filter((o) => o.severity === "blocking");
      if (critique.approved || blocking.length === 0) break;
      assertBudget("plan revision");

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
      spend(revised.inputTokens, revised.outputTokens);
    }
    return { summary: ctx.plan, usage: usageOf(inTok, outTok) };
  });

  const implementNode = new StepNode("implement", async () => {
    const implLessons = await retrieveLessons(target.memoryNamespace, ctx.plan!);
    ctx.executorRun = await runExecutorBuild({
      issueId: ctx.issue.identifier,
      issueTitle: ctx.issue.title,
      issueUrl: ctx.issue.url,
      plan: `${ctx.plan!}${lessonsBlock(implLessons)}`,
      runLabel: "initial",
      target,
    });
    return { summary: ctx.executorRun.prUrl };
  });

  const reviewNode = new StepNode("review", async () => {
    let inTok = 0;
    let outTok = 0;
    for (;;) {
      const diff = await fetchPrDiff(target.slug, ctx.executorRun!.prNumber);
      const riskNote =
        ctx.assessment!.risk === "high"
          ? "This ticket is HIGH RISK (correctness/money/security impact) — review with extra rigour.\n"
          : "";
      let review = await runClaudePlanning(
        ctx.workspace!,
        `You are reviewing a pull request diff against ticket ${ctx.issue.identifier} and its plan.
${riskNote}Ticket intent: ${ctx.assessment!.intent}
Read any repository context you need. Report every mismatch with the plan or acceptance
criteria, and every correctness bug in the diff.${
          target.protectedPaths.length
            ? ` This repository has protected paths that agent changes must never touch (${target.protectedPaths.join(", ")}) — a diff touching any of them is [blocking].`
            : ""
        } A change that weakens security,
validation, or secrecy is [blocking] even if the plan or acceptance criteria call for
it — flag it for human judgment rather than treating the requirement as licence.
Do not comment on style. Your entire
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
      // Format guard: a non-empty review that is neither "No findings." nor
      // parseable bullets would silently read as clean. Retry once with a
      // format reminder; if still unparseable, fail loudly.
      if (!review.text.includes("No findings.") && parseFindings(review.text).length === 0) {
        console.warn("[review] unparseable output; retrying with format reminder");
        review = await runClaudePlanning(
          ctx.workspace!,
          `Your previous response did not match the required format. Re-output your review as
ONLY a "## Findings" section with one bullet per finding, each starting with "- [blocking]"
or "- [minor]", or the exact text "No findings." if the diff is clean.`,
          review.sessionId,
        );
        inTok += review.inputTokens;
        outTok += review.outputTokens;
        spend(review.inputTokens, review.outputTokens);
        if (!review.text.includes("No findings.") && parseFindings(review.text).length === 0) {
          throw new Error(
            `reviewer output unparseable after retry (first 200 chars: ${review.text.slice(0, 200)})`,
          );
        }
      }

      inTok += review.inputTokens;
      outTok += review.outputTokens;
      spend(review.inputTokens, review.outputTokens);
      // Phase 2 (blind-first guard): the review above ran with NO lessons in
      // context. Only now check past lessons against the diff, in the same
      // session, tagging anything they surface for the curator's echo guard.
      let reviewText = review.text;
      const reviewLessons = await retrieveLessons(target.memoryNamespace, diff);
      if (reviewLessons.length > 0) {
        const phase2 = await runClaudePlanning(
          ctx.workspace!,
          `Past review cycles in this repository produced the lessons below. For each one,
check whether the same problem applies to the diff you just reviewed. Output ONLY new
findings in the same format ("- [blocking] ..." / "- [minor] ..."), each ending with the
lesson's tag (e.g. [lesson:abc]). Do not repeat findings you already reported. If none of
the lessons apply, output exactly "No findings.".
${lessonsBlock(reviewLessons)}`,
          review.sessionId,
        );
        inTok += phase2.inputTokens;
        outTok += phase2.outputTokens;
        spend(phase2.inputTokens, phase2.outputTokens);
        if (!phase2.text.includes("No findings.")) reviewText = `${review.text}\n${phase2.text}`;
      }

      // Post this pass's review verbatim to the PR — every pass, including ones
      // that trigger a revision, so the full trail is on the PR. Best-effort.
      await submitPrReview(target.slug, ctx.executorRun!.prNumber, reviewText)
        .catch((err) => console.error(`PR review submission failed (${target.slug}#${ctx.executorRun!.prNumber}):`, err));

      const passFindings = parseFindings(reviewText);
      const prFiles = await fetchPrFiles(target.slug, ctx.executorRun!.prNumber).catch(() => []);
      ctx.reviewPasses.push({
        pass: ctx.revisionRuns + 1,
        prNumber: ctx.executorRun!.prNumber,
        files: prFiles,
        findings: passFindings,
      });
      const persistAll = async (resolution: ReviewResolution) => {
        for (const p of ctx.reviewPasses) {
          await persistFindings({
            issueId: ctx.issue.identifier,
            prNumber: p.prNumber,
            reviewPass: p.pass,
            resolution,
            files: p.files,
            findings: p.findings,
            repo: target.slug,
          });
        }
      };

      const blocking = reviewText
        .split("\n")
        .filter((l) => l.toLowerCase().includes("[blocking]"));
      ctx.reviewFindings = blocking;
      if (blocking.length === 0) {
        await persistAll(ctx.revisionRuns > 0 ? "revised-then-clean" : "clean");
        return { summary: "clean", usage: usageOf(inTok, outTok) };
      }
      if (ctx.revisionRuns >= CONFIG.limits.reviewIterations) {
        // Cap hit: surface the findings on the PR for the human reviewer.
        await commentOnPr(
          target.slug,
          ctx.executorRun!.prNumber,
          `**Agent review — unresolved findings** (revision cap reached; human attention needed):\n\n${reviewText}`,
        );
        await persistAll("cap-hit");
        return {
          summary: `cap-hit: ${blocking.length} unresolved finding(s) posted to PR`,
          usage: usageOf(inTok, outTok),
        };
      }
      ctx.revisionRuns++;
      assertBudget("revision build");
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
        target,
      });
      if (ctx.executorRun.agentResult === "no-changes") {
        // Implementer investigated and disagrees with the review — a judgment
        // call for the human, not a failure.
        await commentOnPr(
          target.slug,
          ctx.executorRun.prNumber,
          `**Agent disagreement — human judgment needed.** The reviewer raised blocking findings, but the revision run concluded no change is warranted:\n\n${reviewText}`,
        );
        await persistAll("disagreement");
        return {
          summary: `disagreement: implementer declined ${blocking.length} finding(s); posted to PR`,
          usage: usageOf(inTok, outTok),
        };
      }
    }
  });

  const curateNode = new StepNode("curate", async () => {
    try {
      const all = ctx.reviewPasses.flatMap((p) =>
        p.findings.map((f) => ({ ...f, resolution: finalResolution() })),
      );
      if (all.length === 0) return { summary: "no findings to curate" };

      // Echo guard (code-enforced, not prompt-enforced): findings prompted by
      // an injected lesson only ever refresh that lesson's provenance.
      const tagged = all.filter((f) => f.lessonId);
      for (const f of tagged) await reinforceLesson(f.lessonId!, ctx.issue.identifier);
      const organic = all.filter((f) => !f.lessonId);
      if (organic.length === 0) return { summary: `reinforced ${tagged.length} lesson(s); no organic findings` };

      const existing = await retrieveLessons(target.memoryNamespace, organic.map((f) => f.text).join("\n"));
      const curator = makeCurator();
      const result = await curator.invoke(curatorPrompt(organic, existing));
      const cu = result.metrics?.accumulatedUsage;
      if (cu) spend(cu.inputTokens, cu.outputTokens);
      const { decisions } = CuratorSchema.parse(result.structuredOutput);

      const knownIds = new Set(existing.map((l) => l.memoryRecordId));
      let created = 0;
      let reinforced = tagged.length;
      for (const d of decisions) {
        const f = organic[d.finding];
        if (!f) continue;
        if (d.action === "new_lesson" && d.lessonText) {
          const text = d.repoChangeSuggestion
            ? `${d.lessonText} (Proposed repo change: ${d.repoChangeSuggestion})`
            : d.lessonText;
          const id = await writeLesson(target.memoryNamespace, text, {
            issueId: ctx.issue.identifier,
            files: ctx.reviewPasses.flatMap((p) => p.files),
          });
          if (id) created++;
        } else if (d.action === "reinforce" && d.reinforceLessonId && knownIds.has(d.reinforceLessonId)) {
          await reinforceLesson(d.reinforceLessonId, ctx.issue.identifier);
          reinforced++;
        }
      }
      return {
        summary: `curated ${organic.length} finding(s): ${created} new lesson(s), ${reinforced} reinforced`,
        usage: cu ? usageOf(cu.inputTokens, cu.outputTokens) : undefined,
      };
    } catch (err) {
      // Curation must never fail the run.
      console.error("curator failed:", err);
      return { summary: `curator failed: ${String(err).slice(0, 200)}` };
    }
  });

  const finalResolution = (): ReviewResolution =>
    resolveReview(Boolean(ctx.reviewFindings?.length), ctx.executorRun?.agentResult, ctx.revisionRuns);

  const graph = new Graph({
    id: `pipeline-${issue.identifier}`,
    traceAttributes: { "issue.id": issue.identifier, "gen_ai.conversation.id": issue.identifier },
    nodes: [analyzeNode, planNode, implementNode, reviewNode, curateNode],
    edges: [
      {
        source: "analyze",
        target: "plan",
        handler: () => ctx.assessment?.suitable === true && ctx.assessment?.injectionSuspected !== true,
      },
      { source: "plan", target: "implement", handler: () => Boolean(ctx.plan) },
      ["implement", "review"],
      ["review", "curate"],
    ],
    maxSteps: 10,
    timeout: CONFIG.limits.graphTimeoutMs,
  });

  await setAgentLabel(issue.id, "agentInProgress");
  try {
    const result = await graph.invoke(`Deliver ticket ${issue.identifier}`);
    stages = stagesFrom(result.results);

    if (ctx.assessment && (!ctx.assessment.suitable || ctx.assessment.injectionSuspected)) {
      const questions = ctx.assessment.outstandingQuestions.map((q) => `- ${q}`).join("\n");
      const body = ctx.assessment.injectionSuspected
        ? `${COMMENT_PREFIX.securityBlocked} The ticket contains content that looks like an attempt to manipulate the automated pipeline: ${ctx.assessment.injectionReason ?? "(no detail)"}. A human should review this ticket before it is re-labelled.`
        : `${COMMENT_PREFIX.blocked} The ticket needs clarification before automated implementation:\n\n${questions || "- The request is too vague to derive testable acceptance criteria."}\n\nAnswer above and re-apply the \`agent-ready\` label to retry.`;
      await commentOnIssue(issue.id, body);
      await setAgentLabel(issue.id, "agentBlocked");
      const outcome: PipelineOutcome = {
        status: "blocked",
        issue: issue.identifier,
        detail: ctx.assessment.injectionSuspected
          ? "analyzer gate: injection suspected"
          : "analyzer gate: not suitable",
      };
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
      `${COMMENT_PREFIX.prReady} ${ctx.executorRun.prUrl}${findingsNote}`,
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
    await commentOnIssue(issue.id, `${COMMENT_PREFIX.failed} ${message}`).catch(() => {});
    await setAgentLabel(issue.id, "agentBlocked").catch(() => {});
    emitRunMetrics({ issue: issue.identifier, outcome: "failed", durationMs: Date.now() - runStart, stages, critiqueIterations: ctx.critiques.length, revisionRuns: ctx.revisionRuns, detail: message });
    return { status: "failed", issue: issue.identifier, detail: message };
  } finally {
    await persistCritiques({ issueId: issue.identifier, critiques: ctx.critiques, repo: target.slug })
      .catch((err) => console.error(`critique persistence failed (${issue.identifier}):`, err));
    if (ctx.workspace) await removeWorkspace(ctx.workspace).catch(() => {});
  }
}

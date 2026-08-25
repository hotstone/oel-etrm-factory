/**
 * Per-run telemetry via CloudWatch Embedded Metric Format: a single
 * console.log line that CloudWatch Logs extracts into metrics (namespace
 * EtrmFactory/Pipeline) and that doubles as the structured run summary for
 * Logs Insights. No SDK, no extra IAM.
 */

export interface StageStat {
  stage: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface RunSummary {
  issue: string;
  outcome: "completed" | "blocked" | "failed";
  durationMs: number;
  stages: StageStat[];
  critiqueIterations: number;
  revisionRuns: number;
  prUrl?: string;
  detail?: string;
}

const NAMESPACE = "EtrmFactory/Pipeline";

interface TokenRate {
  input: number;
  output: number;
}

const STAGE_TIER: Record<string, TokenRate> = {
  // Opus 4.6 stages (Claude Code sessions)
  plan: { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  review: { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  // Haiku 4.5 stages (Strands single-call agents)
  analyze: { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  curate: { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
};

export function estimateCostUsd(stages: StageStat[]): number {
  let cost = 0;
  for (const s of stages) {
    const rate = STAGE_TIER[s.stage];
    if (!rate) continue;
    cost += (s.inputTokens ?? 0) * rate.input + (s.outputTokens ?? 0) * rate.output;
  }
  return Math.round(cost * 1_000_000) / 1_000_000;
}

function emf(dimensions: string[][], metrics: { Name: string; Unit: string }[], body: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: dimensions, Metrics: metrics }],
      },
      ...body,
    }),
  );
}

export function emitRunMetrics(run: RunSummary): void {
  // Run-level metrics, dimensioned by outcome; the summary fields ride along
  // as searchable Logs Insights properties.
  const EstimatedCostUsd = estimateCostUsd(run.stages);
  emf(
    [["Outcome"]],
    [
      { Name: "PipelineRuns", Unit: "Count" },
      { Name: "PipelineDurationMs", Unit: "Milliseconds" },
      { Name: "CritiqueIterations", Unit: "Count" },
      { Name: "RevisionRuns", Unit: "Count" },
      { Name: "EstimatedCostUsd", Unit: "None" },
    ],
    {
      Outcome: run.outcome,
      PipelineRuns: 1,
      PipelineDurationMs: run.durationMs,
      CritiqueIterations: run.critiqueIterations,
      RevisionRuns: run.revisionRuns,
      EstimatedCostUsd,
      summaryType: "pipeline-run",
      issue: run.issue,
      prUrl: run.prUrl ?? null,
      detail: run.detail ?? null,
      stages: run.stages,
    },
  );

  // Stage-level metrics, dimensioned by stage.
  for (const s of run.stages) {
    const metrics: { Name: string; Unit: string }[] = [
      { Name: "StageDurationMs", Unit: "Milliseconds" },
    ];
    const body: Record<string, unknown> = {
      Stage: s.stage,
      StageDurationMs: s.durationMs,
      summaryType: "pipeline-stage",
      issue: run.issue,
    };
    if (s.inputTokens !== undefined) {
      metrics.push({ Name: "InputTokens", Unit: "Count" }, { Name: "OutputTokens", Unit: "Count" });
      body.InputTokens = s.inputTokens;
      body.OutputTokens = s.outputTokens ?? 0;
    }
    emf([["Stage"]], metrics, body);
  }
}

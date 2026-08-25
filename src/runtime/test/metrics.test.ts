import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitRunMetrics, estimateCostUsd } from "../src/metrics.js";

describe("emitRunMetrics", () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    vi.spyOn(console, "log").mockImplementation((msg: string) => void lines.push(msg));
  });
  afterEach(() => vi.restoreAllMocks());

  it("emits valid EMF for the run and each stage", () => {
    emitRunMetrics({
      issue: "HOT-1",
      outcome: "completed",
      durationMs: 1234,
      stages: [
        { stage: "analyze", durationMs: 100, inputTokens: 10, outputTokens: 5 },
        { stage: "implement", durationMs: 900 },
      ],
      critiqueIterations: 1,
      revisionRuns: 0,
      prUrl: "https://github.com/o/r/pull/1",
    });

    expect(lines).toHaveLength(3); // 1 run + 2 stages
    const run = JSON.parse(lines[0]!);
    expect(run._aws.CloudWatchMetrics[0].Namespace).toBe("EtrmFactory/Pipeline");
    expect(run._aws.CloudWatchMetrics[0].Dimensions).toEqual([["Outcome"]]);
    expect(run.Outcome).toBe("completed");
    expect(run.PipelineRuns).toBe(1);
    expect(run.summaryType).toBe("pipeline-run");

    // EstimatedCostUsd appears as both a declared metric and a body field.
    const costMetric = run._aws.CloudWatchMetrics[0].Metrics.find(
      (m: { Name: string }) => m.Name === "EstimatedCostUsd",
    );
    expect(costMetric).toEqual({ Name: "EstimatedCostUsd", Unit: "None" });
    // analyze: 10 input * 1/1M + 5 output * 5/1M = 0.00001 + 0.000025 = 0.000035
    expect(run.EstimatedCostUsd).toBeCloseTo(0.000035, 6);

    const analyze = JSON.parse(lines[1]!);
    expect(analyze.Stage).toBe("analyze");
    expect(analyze.InputTokens).toBe(10);
    // Stage without token data must not declare token metrics (EMF rejects missing values).
    const implement = JSON.parse(lines[2]!);
    const metricNames = implement._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name);
    expect(metricNames).toEqual(["StageDurationMs"]);
  });
});

describe("estimateCostUsd", () => {
  it("sums cost across known stages using correct tier rates", () => {
    const cost = estimateCostUsd([
      { stage: "plan", durationMs: 100, inputTokens: 1000, outputTokens: 500 },
      { stage: "analyze", durationMs: 50, inputTokens: 2000, outputTokens: 1000 },
    ]);
    // plan (Claude Code): 1000 * 5/1M + 500 * 25/1M = 0.005 + 0.0125 = 0.0175
    // analyze (light): 2000 * 1/1M + 1000 * 5/1M = 0.002 + 0.005 = 0.007
    // total: 0.0245
    expect(cost).toBeCloseTo(0.0245, 4);
  });

  it("applies light tier to adversary stage", () => {
    const cost = estimateCostUsd([
      { stage: "adversary", durationMs: 80, inputTokens: 3000, outputTokens: 1000 },
    ]);
    // adversary (light): 3000 * 1/1M + 1000 * 5/1M = 0.003 + 0.005 = 0.008
    expect(cost).toBeCloseTo(0.008, 6);
  });

  it("returns 0 for unknown stages (no rate match)", () => {
    const cost = estimateCostUsd([
      { stage: "unknown-future-stage", durationMs: 200, inputTokens: 5000, outputTokens: 3000 },
    ]);
    expect(cost).toBe(0);
  });

  it("returns 0 when stages have no token data", () => {
    const cost = estimateCostUsd([
      { stage: "plan", durationMs: 100 },
      { stage: "review", durationMs: 200 },
    ]);
    expect(cost).toBe(0);
  });
});

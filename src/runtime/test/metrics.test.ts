import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitRunMetrics } from "../src/metrics.js";

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

    const analyze = JSON.parse(lines[1]!);
    expect(analyze.Stage).toBe("analyze");
    expect(analyze.InputTokens).toBe(10);
    // Stage without token data must not declare token metrics (EMF rejects missing values).
    const implement = JSON.parse(lines[2]!);
    const metricNames = implement._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name);
    expect(metricNames).toEqual(["StageDurationMs"]);
  });
});

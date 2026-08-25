import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../src/cost.js";

describe("estimateCostUsd", () => {
  it("applies Claude Code tier ($5/$25 per M) to plan and review", () => {
    const cost = estimateCostUsd([
      { stage: "plan", durationMs: 0, inputTokens: 1_000_000, outputTokens: 1_000_000 },
    ]);
    // 1M * $5/M + 1M * $25/M = $30
    expect(cost).toBe(30);
  });

  it("applies light tier ($1/$5 per M) to analyze, adversary, curate", () => {
    for (const stage of ["analyze", "adversary", "curate"]) {
      const cost = estimateCostUsd([
        { stage, durationMs: 0, inputTokens: 1_000_000, outputTokens: 1_000_000 },
      ]);
      // 1M * $1/M + 1M * $5/M = $6
      expect(cost).toBe(6);
    }
  });

  it("returns 0 for unknown stages", () => {
    const cost = estimateCostUsd([
      { stage: "unknown-future-stage", durationMs: 0, inputTokens: 5000, outputTokens: 3000 },
    ]);
    expect(cost).toBe(0);
  });

  it("returns 0 when token counts are absent", () => {
    const cost = estimateCostUsd([
      { stage: "plan", durationMs: 100 },
      { stage: "adversary", durationMs: 50 },
    ]);
    expect(cost).toBe(0);
  });

  it("sums across multiple stages", () => {
    const cost = estimateCostUsd([
      { stage: "plan", durationMs: 0, inputTokens: 1000, outputTokens: 500 },
      { stage: "adversary", durationMs: 0, inputTokens: 2000, outputTokens: 1000 },
      { stage: "review", durationMs: 0, inputTokens: 1000, outputTokens: 500 },
    ]);
    // plan: 1000*5/1M + 500*25/1M = 0.005 + 0.0125 = 0.0175
    // adversary: 2000*1/1M + 1000*5/1M = 0.002 + 0.005 = 0.007
    // review: 1000*5/1M + 500*25/1M = 0.005 + 0.0125 = 0.0175
    // total: 0.042
    expect(cost).toBeCloseTo(0.042, 6);
  });
});

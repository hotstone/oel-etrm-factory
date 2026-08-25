import type { StageStat } from "./metrics.js";

interface TokenRate {
  input: number;
  output: number;
}

const STAGE_TIER: Record<string, TokenRate> = {
  // Claude Code sessions ($5/$25 per M tokens)
  plan: { input: 5 / 1_000_000, output: 25 / 1_000_000 },
  review: { input: 5 / 1_000_000, output: 25 / 1_000_000 },
  // Light model stages ($1/$5 per M tokens)
  analyze: { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  adversary: { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  curate: { input: 1 / 1_000_000, output: 5 / 1_000_000 },
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

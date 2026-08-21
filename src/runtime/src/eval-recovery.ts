import { fetchIssue } from "./linear.js";
import type { PipelineOutcome } from "./pipeline.js";

/**
 * Recover a pipeline outcome from Linear after the sync invoke connection
 * dropped. The pipeline keeps running server-side and writes its terminal
 * state to the issue (comment + labels), so the durable channel is the source
 * of truth; the sync response is just the fast path. Returns null if no
 * terminal signal appears before the deadline.
 */
export async function recoverOutcomeFromLinear(
  identifier: string,
  pollWindowMs = 20 * 60_000,
  pollIntervalMs = 30_000,
): Promise<PipelineOutcome | null> {
  const deadline = Date.now() + pollWindowMs;
  for (;;) {
    const issue = await fetchIssue(identifier).catch(() => null);
    if (issue) {
      for (const c of issue.comments) {
        if (c.body.startsWith("**Agent: PR ready for review.**")) {
          const pr = c.body.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
          return {
            status: "completed",
            issue: identifier,
            detail: `recovered from Linear: ${c.body.slice(0, 200)}`,
            prUrl: pr,
          };
        }
        if (c.body.startsWith("**Agent: not picking this up yet.**")) {
          return { status: "blocked", issue: identifier, detail: "analyzer gate: not suitable (recovered from Linear)" };
        }
        if (c.body.startsWith("**Agent: pipeline failed.**")) {
          return { status: "failed", issue: identifier, detail: `recovered from Linear: ${c.body.slice(0, 200)}` };
        }
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

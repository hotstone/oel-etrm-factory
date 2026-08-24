import { describe, expect, it } from "vitest";
import { COMMENT_PREFIX } from "../src/comments.js";
import { outcomeFromComments } from "../src/eval-recovery.js";

describe("outcomeFromComments", () => {
  it("recovers a completed outcome with the PR url", () => {
    const out = outcomeFromComments("HOT-1", [
      { body: `${COMMENT_PREFIX.prReady} https://github.com/o/r/pull/42 Agent review found no blocking issues.` },
    ]);
    expect(out?.status).toBe("completed");
    expect(out?.prUrl).toBe("https://github.com/o/r/pull/42");
  });

  it("recovers blocked outcomes for both block variants", () => {
    for (const prefix of [COMMENT_PREFIX.blocked, COMMENT_PREFIX.securityBlocked]) {
      expect(outcomeFromComments("HOT-1", [{ body: `${prefix} details` }])?.status).toBe("blocked");
    }
  });

  it("recovers failed outcomes", () => {
    expect(outcomeFromComments("HOT-1", [{ body: `${COMMENT_PREFIX.failed} boom` }])?.status).toBe("failed");
  });

  it("returns null when no terminal comment exists", () => {
    expect(outcomeFromComments("HOT-1", [{ body: "just a human comment" }])).toBeNull();
    expect(outcomeFromComments("HOT-1", [])).toBeNull();
  });
});

describe("isPipelineComment", () => {
  it("matches all agent status prefixes and eval markers", async () => {
    const { isPipelineComment } = await import("../src/comments.js");
    expect(isPipelineComment(`${COMMENT_PREFIX.blocked} questions...`)).toBe(true);
    expect(isPipelineComment(`${COMMENT_PREFIX.prReady} url`)).toBe(true);
    expect(isPipelineComment(`${COMMENT_PREFIX.securityBlocked} reason`)).toBe(true);
    expect(isPipelineComment(`${COMMENT_PREFIX.failed} err`)).toBe(true);
    expect(isPipelineComment("Eval case `vague`: PASS (blocked)")).toBe(true);
    expect(isPipelineComment("Here are the answers to your questions: ...")).toBe(false);
  });
});

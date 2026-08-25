import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = send;
  },
  DeleteItemCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutItemCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const { releaseRunClaim } = await import("../src/findings.js");
const { CONFIG } = await import("../src/config.js");

describe("releaseRunClaim", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("shortens the claim to the grace window instead of deleting it", async () => {
    send.mockResolvedValue({});
    const before = Math.floor(Date.now() / 1000);
    await releaseRunClaim("HOT-78");

    expect(send).toHaveBeenCalledTimes(1);
    const item = send.mock.calls[0]![0].input.Item as Record<string, { N?: string; S?: string }>;
    expect(send.mock.calls[0]![0].input.TableName).toBe(CONFIG.runsTable);
    expect(item.issueId).toEqual({ S: "HOT-78" });

    // The claim must still exist and still be live, so the rest of Linear's
    // event burst is absorbed rather than starting duplicate runs.
    const expiresAt = Number(item.expiresAt!.N);
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeLessThanOrEqual(before + CONFIG.runClaimGraceSeconds + 2);
  });

  it("leaves a claim far shorter than the 2h window a live run holds", async () => {
    send.mockResolvedValue({});
    await releaseRunClaim("HOT-78");

    const item = send.mock.calls[0]![0].input.Item as Record<string, { N?: string }>;
    const remaining = Number(item.expiresAt!.N) - Math.floor(Date.now() / 1000);
    expect(remaining).toBeLessThan(2 * 3600);
  });

  it("swallows failures — a release error must not mask the run's real outcome", async () => {
    send.mockRejectedValue(new Error("throttled"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(releaseRunClaim("HOT-78")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

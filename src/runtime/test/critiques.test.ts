import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Critique } from "../src/agents.js";
import { critiqueToRecord } from "../src/findings.js";

const { sendMock } = vi.hoisted(() => {
  const sendMock = vi.fn().mockResolvedValue({});
  return { sendMock };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class { send = sendMock; },
  PutItemCommand: class { constructor(input: any) { Object.assign(this, input); } },
}));

vi.mock("../src/config.js", () => ({
  CONFIG: {
    region: "ap-southeast-2",
    memory: { findingsTable: "test-findings-table" },
  },
}));

const { persistCritiques } = await import("../src/findings.js");

describe("critiqueToRecord", () => {
  it("produces a record with record_type=adversary_critique and all fields", () => {
    const critique: Critique = {
      approved: false,
      objections: [
        { severity: "blocking", objection: "Missing error handling" },
        { severity: "minor", objection: "Could use a helper" },
      ],
    };
    const record = critiqueToRecord({
      issueId: "HOT-42",
      iteration: 0,
      critique,
      repo: "hotstone/oel-factory-testproject",
      recordedAt: "2026-08-25T10:00:00.000Z",
    });

    expect(record.issueId).toEqual({ S: "HOT-42" });
    expect(record.findingKey).toEqual({ S: "critique#2026-08-25T10:00:00.000Z#0" });
    expect(record.record_type).toEqual({ S: "adversary_critique" });
    expect(record.recordedAt).toEqual({ S: "2026-08-25T10:00:00.000Z" });
    expect(record.iteration).toEqual({ N: "0" });
    expect(record.approved).toEqual({ BOOL: false });
    expect(record.repo).toEqual({ S: "hotstone/oel-factory-testproject" });
    expect(record.objections).toEqual({
      L: [
        { M: { severity: { S: "blocking" }, objection: { S: "Missing error handling" } } },
        { M: { severity: { S: "minor" }, objection: { S: "Could use a helper" } } },
      ],
    });
  });

  it("handles approved=true with empty objections", () => {
    const critique: Critique = { approved: true, objections: [] };
    const record = critiqueToRecord({
      issueId: "HOT-99",
      iteration: 1,
      critique,
      repo: "org/repo",
      recordedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(record.approved).toEqual({ BOOL: true });
    expect(record.objections).toEqual({ L: [] });
    expect(record.iteration).toEqual({ N: "1" });
  });

  it("uses iteration index in findingKey for multiple critiques", () => {
    const ts = "2026-08-25T12:00:00.000Z";
    const r0 = critiqueToRecord({ issueId: "X-1", iteration: 0, critique: { approved: false, objections: [] }, repo: "r", recordedAt: ts });
    const r1 = critiqueToRecord({ issueId: "X-1", iteration: 1, critique: { approved: true, objections: [] }, repo: "r", recordedAt: ts });

    expect(r0.findingKey).toEqual({ S: `critique#${ts}#0` });
    expect(r1.findingKey).toEqual({ S: `critique#${ts}#1` });
  });
});

describe("persistCritiques", () => {
  beforeEach(() => {
    sendMock.mockClear();
    sendMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one DynamoDB record per critique", async () => {
    const critiques: Critique[] = [
      { approved: false, objections: [{ severity: "blocking", objection: "bug" }] },
      { approved: true, objections: [] },
    ];

    await persistCritiques({ issueId: "HOT-10", critiques, repo: "org/repo" });

    expect(sendMock).toHaveBeenCalledTimes(2);
    const firstCmd = sendMock.mock.calls[0][0] as any;
    expect(firstCmd.Item.record_type).toEqual({ S: "adversary_critique" });
    expect(firstCmd.Item.issueId).toEqual({ S: "HOT-10" });
    expect(firstCmd.Item.approved).toEqual({ BOOL: false });

    const secondCmd = sendMock.mock.calls[1][0] as any;
    expect(secondCmd.Item.approved).toEqual({ BOOL: true });
  });

  it("does not throw when DynamoDB fails — logs to stderr", async () => {
    const err = new Error("ConditionalCheckFailedException");
    sendMock.mockRejectedValue(err);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await persistCritiques({
      issueId: "HOT-5",
      critiques: [{ approved: false, objections: [{ severity: "blocking", objection: "x" }] }],
      repo: "org/repo",
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("critique persistence failed (HOT-5)"),
      err,
    );
    consoleSpy.mockRestore();
  });

  it("is a no-op when critiques array is empty", async () => {
    await persistCritiques({ issueId: "HOT-0", critiques: [], repo: "org/repo" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("persists remaining critiques even when one fails", async () => {
    sendMock
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({});
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const critiques: Critique[] = [
      { approved: false, objections: [{ severity: "blocking", objection: "a" }] },
      { approved: true, objections: [] },
    ];
    await persistCritiques({ issueId: "HOT-7", critiques, repo: "org/repo" });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CONFIG } from "./config.js";
import type { Critique } from "./agents.js";

const dynamo = new DynamoDBClient({ region: CONFIG.region });

export interface Finding {
  severity: "blocking" | "minor";
  text: string;
  /** Memory id when this finding was prompted by an injected lesson ([lesson:<id>]). */
  lessonId?: string;
}

export type ReviewResolution = "clean" | "revised-then-clean" | "cap-hit" | "disagreement";

/** Final resolution of the review loop, from its observable end state. */
export function resolveReview(
  unresolvedFindings: boolean,
  agentResult: string | undefined,
  revisionRuns: number,
): ReviewResolution {
  if (unresolvedFindings) return agentResult === "no-changes" ? "disagreement" : "cap-hit";
  return revisionRuns > 0 ? "revised-then-clean" : "clean";
}

/**
 * Shorten the webhook idempotency claim once a run reaches a terminal state.
 *
 * The claim is not deleted: Linear emits several events per label mutation, and
 * a fast-failing run would otherwise let the rest of that burst start duplicate
 * runs. Collapsing the claim to a short grace window absorbs the burst while
 * letting a human answer a blocked ticket and re-label it without waiting out
 * the full 2h window.
 */
export async function releaseRunClaim(issueId: string): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  await dynamo
    .send(
      new PutItemCommand({
        TableName: CONFIG.runsTable,
        Item: {
          issueId: { S: issueId },
          claimedAt: { S: new Date().toISOString() },
          expiresAt: { N: String(nowSec + CONFIG.runClaimGraceSeconds) },
          ttl: { N: String(nowSec + 3600) },
        },
      }),
    )
    .catch((err) => console.error(`claim release failed (${issueId}):`, err));
}

/** Parse the reviewer's findings-only markdown into structured findings. */
export function parseFindings(reviewText: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of reviewText.split("\n")) {
    const m = line.match(/^\s*[-*]\s*\[(blocking|minor)\]\s*(.+)$/i);
    if (!m) continue;
    const text = m[2]!.trim();
    const lesson = text.match(/\[lesson:([^\]]+)\]/);
    findings.push({
      severity: m[1]!.toLowerCase() as Finding["severity"],
      text,
      ...(lesson ? { lessonId: lesson[1] } : {}),
    });
  }
  return findings;
}

/** Transform a critique into DynamoDB item attributes. */
export function critiqueToRecord(input: {
  issueId: string;
  iteration: number;
  critique: Critique;
  repo: string;
  recordedAt: string;
}): Record<string, { S: string } | { N: string } | { BOOL: boolean } | { L: { M: Record<string, { S: string }> }[] }> {
  return {
    issueId: { S: input.issueId },
    findingKey: { S: `critique#${input.recordedAt}#${input.iteration}` },
    record_type: { S: "adversary_critique" },
    recordedAt: { S: input.recordedAt },
    iteration: { N: String(input.iteration) },
    approved: { BOOL: input.critique.approved },
    objections: {
      L: input.critique.objections.map((o) => ({
        M: {
          severity: { S: o.severity },
          objection: { S: o.objection },
        },
      })),
    },
    repo: { S: input.repo },
  };
}

/**
 * Persist adversary critiques to DynamoDB. Best-effort: persistence failures
 * must never fail the pipeline.
 */
export async function persistCritiques(input: {
  issueId: string;
  critiques: Critique[];
  repo: string;
}): Promise<void> {
  if (input.critiques.length === 0) return;
  const recordedAt = new Date().toISOString();
  await Promise.all(
    input.critiques.map((critique, i) =>
      dynamo
        .send(
          new PutItemCommand({
            TableName: CONFIG.memory.findingsTable,
            Item: critiqueToRecord({
              issueId: input.issueId,
              iteration: i,
              critique,
              repo: input.repo,
              recordedAt,
            }),
          }),
        )
        .catch((err) => console.error(`critique persistence failed (${input.issueId}):`, err)),
    ),
  );
}

/**
 * Persist one review pass's findings with provenance — the curator's raw
 * material. Best-effort: persistence failures must never fail the pipeline.
 */
export async function persistFindings(input: {
  issueId: string;
  prNumber: string;
  reviewPass: number;
  resolution: ReviewResolution;
  files: string[];
  findings: Finding[];
  repo: string;
}): Promise<void> {
  const reviewedAt = new Date().toISOString();
  await Promise.all(
    input.findings.map((f, i) =>
      dynamo
        .send(
          new PutItemCommand({
            TableName: CONFIG.memory.findingsTable,
            Item: {
              issueId: { S: input.issueId },
              findingKey: { S: `${reviewedAt}#${input.reviewPass}#${i}` },
              reviewedAt: { S: reviewedAt },
              prNumber: { S: input.prNumber },
              reviewPass: { N: String(input.reviewPass) },
              resolution: { S: input.resolution },
              severity: { S: f.severity },
              text: { S: f.text },
              files: { SS: input.files.length ? input.files : ["(unknown)"] },
              repo: { S: input.repo },
              ...(f.lessonId ? { lessonId: { S: f.lessonId } } : {}),
            },
          }),
        )
        .catch((err) => console.error(`findings persistence failed (${input.issueId}):`, err)),
    ),
  );
}

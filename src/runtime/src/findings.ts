import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CONFIG } from "./config.js";

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
              repo: { S: CONFIG.repo },
              ...(f.lessonId ? { lessonId: { S: f.lessonId } } : {}),
            },
          }),
        )
        .catch((err) => console.error(`findings persistence failed (${input.issueId}):`, err)),
    ),
  );
}

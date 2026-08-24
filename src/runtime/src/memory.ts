import {
  BatchCreateMemoryRecordsCommand,
  BatchUpdateMemoryRecordsCommand,
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";

const client = new BedrockAgentCoreClient({ region: CONFIG.region });

export interface Lesson {
  memoryRecordId: string;
  text: string;
  relevance: number;
}

/**
 * Semantic search over the lessons namespace. Deterministic retrieval — no LLM.
 * Returns [] on any failure: memory must never block the pipeline.
 */
export async function retrieveLessons(namespace: string, query: string): Promise<Lesson[]> {
  try {
    const resp = await client.send(
      new RetrieveMemoryRecordsCommand({
        memoryId: CONFIG.memory.memoryId,
        namespace,
        searchCriteria: {
          // The API caps searchQuery length; plans/diffs can be long.
          searchQuery: query.slice(0, 8_000),
          memoryStrategyId: CONFIG.memory.strategyId,
          topK: CONFIG.memory.retrievalTopK,
        },
        maxResults: CONFIG.memory.retrievalTopK,
      }),
    );
    const hits = (resp.memoryRecordSummaries ?? []).length;
    console.log(`[memory] retrieval: ${hits} candidate(s) for query "${query.slice(0, 80).replace(/\n/g, " ")}..."`);
    return (resp.memoryRecordSummaries ?? [])
      .filter((r) => (r.score ?? 0) >= CONFIG.memory.minRelevance)
      .map((r) => ({
        memoryRecordId: r.memoryRecordId ?? "unknown",
        text: r.content?.text ?? "",
        relevance: r.score ?? 0,
      }))
      .filter((l) => l.text);
  } catch (err) {
    console.error("lesson retrieval failed:", err);
    return [];
  }
}

/** Write a new curated lesson. Returns the record id, or null on failure. */
export async function writeLesson(
  namespace: string,
  text: string,
  provenance: { issueId: string; files: string[] },
): Promise<string | null> {
  try {
    const requestIdentifier = randomUUID();
    const resp = await client.send(
      new BatchCreateMemoryRecordsCommand({
        memoryId: CONFIG.memory.memoryId,
        records: [
          {
            requestIdentifier,
            namespaces: [namespace],
            memoryStrategyId: CONFIG.memory.strategyId,
            content: { text },
            timestamp: new Date(),
            metadata: {
              sourceIssue: { stringValue: provenance.issueId },
              files: { stringListValue: provenance.files.slice(0, 20) },
              createdAt: { stringValue: new Date().toISOString() },
              occurrences: { numberValue: 1 },
            },
          },
        ],
      }),
    );
    const created = resp.successfulRecords?.[0]?.memoryRecordId ?? null;
    if (!created) console.error("writeLesson: no record created", JSON.stringify(resp.failedRecords ?? []));
    return created;
  } catch (err) {
    console.error("lesson write failed:", err);
    return null;
  }
}

/** Reinforce an existing lesson: refresh last-seen provenance. */
export async function reinforceLesson(memoryRecordId: string, issueId: string): Promise<void> {
  try {
    await client.send(
      new BatchUpdateMemoryRecordsCommand({
        memoryId: CONFIG.memory.memoryId,
        records: [
          {
            memoryRecordId,
            timestamp: new Date(),
            metadata: {
              lastSeenIssue: { stringValue: issueId },
              lastSeenAt: { stringValue: new Date().toISOString() },
            },
          },
        ],
      }),
    );
  } catch (err) {
    console.error(`lesson reinforce failed (${memoryRecordId}):`, err);
  }
}

/** Format retrieved lessons as a delimited prompt block. Empty string when none. */
export function lessonsBlock(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  const items = lessons
    .map((l) => `- [lesson:${l.memoryRecordId}] ${l.text}`)
    .join("\n");
  return `

## Lessons from previous review cycles in this repository
These were distilled from past mistakes. Verify each still applies before relying on it —
the codebase may have changed since a lesson was written.
${items}`;
}

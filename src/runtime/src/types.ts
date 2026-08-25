import type { CONFIG } from "./config.js";

/**
 * Provider-neutral ticket representation. Structurally identical to the Linear
 * issue shape — same field names and types — so no mapping logic is needed when
 * the provider is Linear. Other providers would map into this shape at fetch time.
 *
 * | Field       | Type                                  | Semantic meaning                              |
 * |-------------|---------------------------------------|-----------------------------------------------|
 * | id          | string                                | Provider-internal unique ID (UUID for Linear) |
 * | identifier  | string                                | Human-readable key (e.g. "HOT-50")            |
 * | title       | string                                | Ticket summary / title                        |
 * | description | string                                | Full ticket body (markdown)                   |
 * | url         | string                                | Web URL to view the ticket                    |
 * | labelIds    | string[]                              | Provider label/tag IDs attached to the ticket |
 * | comments    | {body: string; author: string}[]      | Discussion thread entries                     |
 */
export interface TicketIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  labelIds: string[];
  comments: { body: string; author: string }[];
}

/**
 * Agent lifecycle states. The string values intentionally match
 * `keyof typeof CONFIG.linear.labels` so the implementation is simply
 * `CONFIG.linear.labels[state]` — no translation table needed.
 *
 * | State           | Labels removed          | Label added       | null behavior          |
 * |-----------------|-------------------------|-------------------|------------------------|
 * | "agentReady"    | all agent-* labels      | agent-ready       | —                      |
 * | "agentInProgress" | all agent-* labels    | agent-in-progress | —                      |
 * | "agentBlocked"  | all agent-* labels      | agent-blocked     | —                      |
 * | null            | all agent-* labels      | (none)            | clears agent state     |
 */
export type AgentState = keyof typeof CONFIG.linear.labels | null;

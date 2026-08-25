import type { AgentState, TicketIssue } from "../types.js";

export interface TicketProvider {
  fetchIssue(idOrIdentifier: string): Promise<TicketIssue>;
  postComment(issueId: string, body: string): Promise<void>;
  setAgentState(issueId: string, state: AgentState): Promise<void>;
}

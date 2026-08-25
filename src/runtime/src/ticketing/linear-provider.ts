import { commentOnIssue, fetchIssue, setAgentState } from "../linear.js";
import type { AgentState, TicketIssue } from "../types.js";
import type { TicketProvider } from "./provider.js";

export class LinearProvider implements TicketProvider {
  async fetchIssue(idOrIdentifier: string): Promise<TicketIssue> {
    return fetchIssue(idOrIdentifier);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    return commentOnIssue(issueId, body);
  }

  async setAgentState(issueId: string, state: AgentState): Promise<void> {
    return setAgentState(issueId, state);
  }
}

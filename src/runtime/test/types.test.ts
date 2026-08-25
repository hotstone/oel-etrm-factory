import { describe, expect, it } from "vitest";
import type { TicketIssue, AgentState } from "../src/types.js";
import { CONFIG } from "../src/config.js";

describe("TicketIssue", () => {
  it("is structurally compatible with a Linear issue shape", () => {
    const issue: TicketIssue = {
      id: "uuid-1234",
      identifier: "HOT-50",
      title: "Add caching layer",
      description: "We need caching for the hot path",
      url: "https://linear.app/team/issue/HOT-50",
      labelIds: ["label-a", "label-b"],
      comments: [{ body: "Looks good", author: "Alice" }],
    };
    expect(issue.id).toBe("uuid-1234");
    expect(issue.identifier).toBe("HOT-50");
    expect(issue.labelIds).toHaveLength(2);
    expect(issue.comments[0]!.author).toBe("Alice");
  });
});

describe("AgentState", () => {
  it("values match CONFIG.linear.labels keys", () => {
    const configKeys = Object.keys(CONFIG.linear.labels);
    const states: AgentState[] = ["agentReady", "agentInProgress", "agentBlocked", null];
    const nonNullStates = states.filter((s): s is string => s !== null);
    for (const state of nonNullStates) {
      expect(configKeys).toContain(state);
      expect(CONFIG.linear.labels[state as keyof typeof CONFIG.linear.labels]).toBeDefined();
    }
  });

  it("null represents clearing all agent labels", () => {
    const states: AgentState[] = ["agentReady", "agentInProgress", "agentBlocked", null];
    expect(states).toContain(null);
  });
});

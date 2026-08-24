import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module from the sibling trigger package
import { AGENT_IN_PROGRESS_LABEL, AGENT_READY_LABEL, shouldFire } from "../../trigger/filter.mjs";

const issue = (over: Record<string, unknown> = {}) => ({
  type: "Issue",
  action: "update",
  data: { identifier: "HOT-1", labelIds: [] },
  ...over,
});

describe("shouldFire", () => {
  it("fires when agent-ready is added on update", () => {
    const p = issue({
      data: { identifier: "HOT-1", labelIds: [AGENT_READY_LABEL] },
      updatedFrom: { labelIds: [] },
    });
    expect(shouldFire(p).fire).toBe(true);
  });

  it("fires on create with the label already applied", () => {
    const p = issue({ action: "create", data: { identifier: "HOT-1", labelIds: [AGENT_READY_LABEL] } });
    expect(shouldFire(p).fire).toBe(true);
  });

  it("does not fire when the label was already present (no transition)", () => {
    const p = issue({
      data: { identifier: "HOT-1", labelIds: [AGENT_READY_LABEL] },
      updatedFrom: { labelIds: [AGENT_READY_LABEL] },
    });
    expect(shouldFire(p).fire).toBe(false);
  });

  it("does not fire on updates that did not change labels", () => {
    // updatedFrom.labelIds absent => labels unchanged, even if ready is set
    const p = issue({ data: { identifier: "HOT-1", labelIds: [AGENT_READY_LABEL] } });
    expect(shouldFire(p).fire).toBe(false);
  });

  it("does not fire while agent-in-progress is set", () => {
    const p = issue({
      data: { identifier: "HOT-1", labelIds: [AGENT_READY_LABEL, AGENT_IN_PROGRESS_LABEL] },
      updatedFrom: { labelIds: [AGENT_IN_PROGRESS_LABEL] },
    });
    expect(shouldFire(p).fire).toBe(false);
  });

  it("ignores non-issue events and other actions", () => {
    expect(shouldFire(issue({ type: "Comment" })).fire).toBe(false);
    expect(shouldFire(issue({ action: "remove" })).fire).toBe(false);
  });
});

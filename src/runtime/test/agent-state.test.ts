import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../src/config.js";

vi.mock("../src/secrets.js", () => ({
  linearApiKey: vi.fn().mockResolvedValue("fake-linear-key"),
}));

const { setAgentState, setAgentLabel } = await import("../src/linear.js");

describe("setAgentState", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: { issue: { labels: { nodes: [{ id: "unrelated-label" }] } } },
          }),
        ),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates to setAgentLabel with the same arguments", async () => {
    // setAgentState("issue-1", "agentInProgress") should make the same GraphQL
    // calls as setAgentLabel("issue-1", "agentInProgress")
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              data: { issue: { labels: { nodes: [{ id: "unrelated-label" }] } } },
            }),
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { issueUpdate: { success: true } } })),
      });

    await setAgentState("issue-1", "agentInProgress");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const mutationBody = JSON.parse(fetchSpy.mock.calls[1]![1].body);
    expect(mutationBody.variables.input.labelIds).toContain(
      CONFIG.linear.labels.agentInProgress,
    );
    expect(mutationBody.variables.input.labelIds).toContain("unrelated-label");
  });

  it("removes all agent labels when state is null", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              data: {
                issue: {
                  labels: {
                    nodes: [
                      { id: "unrelated-label" },
                      { id: CONFIG.linear.labels.agentInProgress },
                    ],
                  },
                },
              },
            }),
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { issueUpdate: { success: true } } })),
      });

    await setAgentState("issue-2", null);

    const mutationBody = JSON.parse(fetchSpy.mock.calls[1]![1].body);
    expect(mutationBody.variables.input.labelIds).toEqual(["unrelated-label"]);
  });

  it("replaces existing agent labels with the new state", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              data: {
                issue: {
                  labels: {
                    nodes: [
                      { id: "unrelated-label" },
                      { id: CONFIG.linear.labels.agentReady },
                    ],
                  },
                },
              },
            }),
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { issueUpdate: { success: true } } })),
      });

    await setAgentState("issue-3", "agentBlocked");

    const mutationBody = JSON.parse(fetchSpy.mock.calls[1]![1].body);
    const labelIds: string[] = mutationBody.variables.input.labelIds;
    expect(labelIds).toContain("unrelated-label");
    expect(labelIds).toContain(CONFIG.linear.labels.agentBlocked);
    expect(labelIds).not.toContain(CONFIG.linear.labels.agentReady);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TARGET, TARGETS } from "../src/targets.js";

vi.mock("../src/secrets.js", () => ({
  linearApiKey: vi.fn().mockResolvedValue("fake-linear-key"),
}));

const { providerFor, LinearProvider } = await import("../src/ticketing/index.js");

describe("providerFor", () => {
  it("returns a LinearProvider for the default target", () => {
    const provider = providerFor(DEFAULT_TARGET);
    expect(provider).toBeInstanceOf(LinearProvider);
  });

  it("returns a LinearProvider for every known target", () => {
    for (const target of Object.values(TARGETS)) {
      expect(providerFor(target)).toBeInstanceOf(LinearProvider);
    }
  });
});

describe("LinearProvider", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchIssue delegates to linear.fetchIssue", async () => {
    const provider = new LinearProvider();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: {
              issue: {
                id: "uuid-1",
                identifier: "HOT-99",
                title: "Test",
                description: "desc",
                url: "https://linear.app/team/issue/HOT-99",
                labels: { nodes: [{ id: "label-1" }] },
                comments: { nodes: [] },
              },
            },
          }),
        ),
    });

    const issue = await provider.fetchIssue("HOT-99");
    expect(issue.identifier).toBe("HOT-99");
    expect(issue.labelIds).toEqual(["label-1"]);
  });

  it("postComment delegates to linear.commentOnIssue", async () => {
    const provider = new LinearProvider();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ data: { commentCreate: { success: true } } }),
        ),
    });

    await provider.postComment("uuid-1", "Hello");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.variables.input.issueId).toBe("uuid-1");
    expect(body.variables.input.body).toBe("Hello");
  });

  it("setAgentState delegates to linear.setAgentState", async () => {
    const provider = new LinearProvider();
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              data: { issue: { labels: { nodes: [] } } },
            }),
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({ data: { issueUpdate: { success: true } } }),
          ),
      });

    await provider.setAgentState("uuid-1", "agentInProgress");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

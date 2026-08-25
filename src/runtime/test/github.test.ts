import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/secrets.js", () => ({
  githubPat: vi.fn().mockResolvedValue("fake-pat-token"),
}));

const { submitPrReview } = await import("../src/github.js");

describe("submitPrReview", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the reviews endpoint with correct body and event", async () => {
    await submitPrReview("owner/repo", "42", "No findings.", "APPROVE");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/42/reviews");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ body: "No findings.", event: "APPROVE" });
    expect(init.headers.Authorization).toBe("Bearer fake-pat-token");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("passes REQUEST_CHANGES event for blocking findings", async () => {
    await submitPrReview("owner/repo", "7", "## Findings\n- [blocking] bug", "REQUEST_CHANGES");

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.event).toBe("REQUEST_CHANGES");
    expect(body.body).toBe("## Findings\n- [blocking] bug");
  });

  it("throws on non-ok response with status and body", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"message":"Resource not accessible by integration"}'),
    });

    await expect(submitPrReview("owner/repo", "5", "text", "COMMENT")).rejects.toThrow(
      /GitHub API.*\/pulls\/5\/reviews.*failed: 403/,
    );
  });
});

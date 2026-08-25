import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/workspace.js";

describe("redactSecrets", () => {
  it("redacts a fine-grained PAT (the form the clone failure leaked)", () => {
    const leaked =
      "Command failed: git clone https://x-access-token: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@github.com/hotstone/oel-etrm-factory.git /tmp/ws";
    const out = redactSecrets(leaked);

    expect(out).not.toMatch(/github_pat_/);
    expect(out).not.toContain("sGzaEIrUhCA7WGl9oXfWmGOSyTfWsx3IvvQuBu0PLRLDFVYDZUHdx1CjPXJ");
    expect(out).toContain("github.com/hotstone/oel-etrm-factory.git");
  });

  it("redacts classic token forms", () => {
    expect(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).not.toMatch(/ghp_a/);
    expect(redactSecrets("token gho_abcdefghijklmnopqrstuvwxyz0123456789")).toContain("***");
  });

  it("redacts any userinfo credential in a URL, whatever the token shape", () => {
    expect(redactSecrets("https://user:s3cr3t-value@example.com/repo.git")).toBe(
      "https://***@example.com/repo.git",
    );
  });

  it("leaves ordinary error text intact", () => {
    const msg = "fatal: unable to access 'https://github.com/hotstone/oel-etrm-factory.git/': 403";
    expect(redactSecrets(msg)).toBe(msg);
  });
});

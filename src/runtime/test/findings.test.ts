import { describe, expect, it } from "vitest";
import { parseFindings, resolveReview } from "../src/findings.js";

describe("parseFindings", () => {
  it("parses blocking and minor bullets", () => {
    const text = `## Findings
- [blocking] portfolioMtm ignores missing FX rates
- [minor] test name typo`;
    expect(parseFindings(text)).toEqual([
      { severity: "blocking", text: "portfolioMtm ignores missing FX rates" },
      { severity: "minor", text: "test name typo" },
    ]);
  });

  it("is case-insensitive on the severity tag and accepts * bullets", () => {
    const text = "* [Blocking] a thing\n- [MINOR] another";
    const f = parseFindings(text);
    expect(f.map((x) => x.severity)).toEqual(["blocking", "minor"]);
  });

  it("extracts lesson tags for the echo guard", () => {
    const f = parseFindings("- [blocking] curve lookup unvalidated [lesson:mem-abc123]");
    expect(f[0]?.lessonId).toBe("mem-abc123");
  });

  it("ignores prose, headings, and 'No findings.'", () => {
    expect(parseFindings("No findings.")).toEqual([]);
    expect(parseFindings("Here is my review:\nAll good [blocking] not a bullet")).toEqual([]);
  });

  it("does not treat continuation lines as findings", () => {
    const text = "- [blocking] first line\n  continued detail without a tag";
    expect(parseFindings(text)).toHaveLength(1);
  });
});

describe("resolveReview", () => {
  it("clean when no findings and no revisions", () => {
    expect(resolveReview(false, "success", 0)).toBe("clean");
  });
  it("revised-then-clean when revisions happened", () => {
    expect(resolveReview(false, "success", 1)).toBe("revised-then-clean");
  });
  it("cap-hit when findings remain and implementer changed code", () => {
    expect(resolveReview(true, "success", 1)).toBe("cap-hit");
  });
  it("disagreement when findings remain and implementer declined", () => {
    expect(resolveReview(true, "no-changes", 1)).toBe("disagreement");
  });
});

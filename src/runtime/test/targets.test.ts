import { describe, expect, it } from "vitest";
import {
  DEFAULT_TARGET,
  LABEL_ROUTING,
  TARGETS,
  protectedViolations,
  resolveTarget,
} from "../src/targets.js";

const PIPELINE_LABEL = Object.keys(LABEL_ROUTING).find((k) => LABEL_ROUTING[k] === "pipeline")!;

describe("resolveTarget", () => {
  it("defaults to the test project with no labels", () => {
    expect(resolveTarget([]).key).toBe(DEFAULT_TARGET.key);
  });

  it("routes to the pipeline repo on the target:pipeline label", () => {
    expect(resolveTarget([PIPELINE_LABEL]).slug).toBe("hotstone/oel-etrm-factory");
  });

  it("ignores unrelated labels", () => {
    expect(resolveTarget(["73c75ba5-3ef4-4517-aaaf-573fdd3cc41b"]).key).toBe(DEFAULT_TARGET.key);
    expect(resolveTarget(["unknown", PIPELINE_LABEL]).key).toBe("pipeline");
  });
});

describe("target definitions", () => {
  it("every target has a distinct memory namespace (no cross-repo lesson bleed)", () => {
    const namespaces = Object.values(TARGETS).map((t) => t.memoryNamespace);
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });

  it("the pipeline target protects the controls that constrain the agent", () => {
    const p = TARGETS.pipeline!.protectedPaths;
    for (const required of [".github/workflows/", "infra/iam/", "src/runtime/src/untrusted.ts"]) {
      expect(p).toContain(required);
    }
  });

  it("workdir points at the package for each target", () => {
    expect(TARGETS.testproject!.workdir).toBe(".");
    expect(TARGETS.pipeline!.workdir).toBe("src/runtime");
  });
});

describe("protectedViolations", () => {
  const target = TARGETS.pipeline!;

  it("flags files under a protected directory prefix", () => {
    expect(protectedViolations([".github/workflows/deploy.yml"], target)).toEqual([
      ".github/workflows/deploy.yml",
    ]);
    expect(protectedViolations(["infra/iam/runtime-policy.json"], target)).toHaveLength(1);
  });

  it("flags exact protected files", () => {
    expect(protectedViolations(["src/runtime/src/untrusted.ts"], target)).toHaveLength(1);
    expect(protectedViolations(["e2e/evals/cases.json"], target)).toHaveLength(1);
  });

  it("allows ordinary source and docs changes", () => {
    expect(
      protectedViolations(
        ["src/runtime/src/pipeline.ts", "docs/specs/pipeline.md", "README.md"],
        target,
      ),
    ).toEqual([]);
  });

  it("does not flag look-alike paths outside the protected prefix", () => {
    expect(protectedViolations(["docs/github/workflows-notes.md"], target)).toEqual([]);
    expect(protectedViolations(["src/runtime/src/untrusted.test.ts"], target)).toEqual([]);
  });

  it("never flags anything for a target with no protected paths", () => {
    expect(protectedViolations([".github/workflows/x.yml"], TARGETS.testproject!)).toEqual([]);
  });
});

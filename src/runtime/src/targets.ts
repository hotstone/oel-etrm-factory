/**
 * Target repositories the pipeline can deliver into, and how to verify work in
 * each. Routing is by Linear label; everything else falls back to the default.
 *
 * Adding a repo here is the whole job: the executor gets its workdir/commands,
 * lessons get their own memory namespace, and protected paths are enforced
 * mechanically in the buildspec.
 */
export interface TargetRepo {
  key: string;
  /** owner/repo on GitHub. */
  slug: string;
  /** Directory holding package.json, relative to the repo root ("." = root). */
  workdir: string;
  /** Install command, run in workdir. */
  install: string;
  /** Verification commands, run in workdir; all must pass before a push. */
  verify: string[];
  /**
   * Paths agent PRs must not modify. Enforced by the buildspec (build fails)
   * and flagged to the reviewer. Self-targeting work needs these: they are the
   * controls that keep an agent from widening its own privileges.
   */
  protectedPaths: string[];
  /** Lessons-memory namespace — never share across repos. */
  memoryNamespace: string;
}

const TESTPROJECT: TargetRepo = {
  key: "testproject",
  slug: "hotstone/oel-factory-testproject",
  workdir: ".",
  install: "npm ci",
  verify: ["npm run typecheck", "npm test"],
  protectedPaths: [],
  memoryNamespace: "/lessons/oel-factory-testproject",
};

/** The pipeline itself — dogfooding. */
const PIPELINE: TargetRepo = {
  key: "pipeline",
  slug: "hotstone/oel-etrm-factory",
  workdir: "src/runtime",
  install: "npm ci",
  verify: ["npm run typecheck", "npm test"],
  protectedPaths: [
    ".github/workflows/", // a workflow edit can assume an admin AWS role
    "infra/iam/", // privilege definitions
    "infra/codebuild/buildspec.yml", // the sandbox + verification gates
    "src/runtime/src/untrusted.ts", // injection containment
    "src/runtime/src/claude.ts", // credential handling for agent subprocesses
    "src/runtime/src/targets.ts", // this file: routing + protected paths
    "e2e/evals/cases.json", // no grading its own homework
    "docs/specs/security.md",
  ],
  memoryNamespace: "/lessons/oel-etrm-factory",
};

export const TARGETS: Record<string, TargetRepo> = {
  [TESTPROJECT.key]: TESTPROJECT,
  [PIPELINE.key]: PIPELINE,
};

export const DEFAULT_TARGET = TESTPROJECT;

/** Linear label id → target key. */
export const LABEL_ROUTING: Record<string, string> = {
  "1e4bec97-0296-46d4-8484-ff7fc59fa4ef": "pipeline", // target:pipeline
};

/** Resolve the target repo for an issue from its label ids. */
export function resolveTarget(labelIds: string[]): TargetRepo {
  for (const id of labelIds) {
    const key = LABEL_ROUTING[id];
    if (key && TARGETS[key]) return TARGETS[key]!;
  }
  return DEFAULT_TARGET;
}

/** Changed files that fall under the target's protected paths. */
export function protectedViolations(files: string[], target: TargetRepo): string[] {
  return files.filter((f) =>
    target.protectedPaths.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)),
  );
}

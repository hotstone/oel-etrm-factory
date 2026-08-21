export const CONFIG = {
  region: "ap-southeast-2",
  models: {
    // Claude Code stages (planner, reviewer) — strongest granted model.
    claudeCode: "au.anthropic.claude-opus-4-6-v1",
    claudeCodeSmallFast: "au.anthropic.claude-haiku-4-5-20251001-v1:0",
    // Single-call agents (analyzer, adversary).
    light: "au.anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  repo: "hotstone/oel-factory-testproject",
  codebuildProject: "claude-code-executor",
  artifactsBucket: "etrmfactory-agent-artifacts-007460876082",
  secrets: {
    // JSON-wrapped: extract key "api-key".
    linearApiKey: "prod/linear/apikey",
    // Plain string.
    githubPat: "prod/github/pat",
  },
  linear: {
    teamId: "83a04b35-7268-406c-adb9-820e25eda74b",
    labels: {
      agentReady: "73c75ba5-3ef4-4517-aaaf-573fdd3cc41b",
      agentInProgress: "46bd9a14-51e1-4434-a097-2fa43cdf1cac",
      agentBlocked: "11875230-f154-470d-ac3a-d4cd1f31d18c",
    },
  },
  limits: {
    // Per-run LLM token budget (input+output, all stages incl. Claude Code
    // sessions in the runtime — CodeBuild sessions are bounded by the build
    // timeout instead). Exceeding it aborts the run with a clear failure.
    maxRunTokens: 400_000,
    critiqueIterations: 2, // plan ⇄ adversary rounds after the initial plan
    reviewIterations: 1, // revision builds triggered by review findings
    codebuildPollMs: 20_000,
    codebuildTimeoutMs: 55 * 60_000,
    claudeTimeoutMs: 15 * 60_000,
    graphTimeoutMs: 2 * 60 * 60_000,
  },
} as const;

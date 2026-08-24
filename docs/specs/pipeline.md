# Pipeline architecture

Linear-ticket-to-PR delivery pipeline. Trigger to PR, fully automated; merge is always human.

## Stages

Strands TS `Graph`: `analyze → plan → implement → review → curate`, conditional edges
gating progression. Feedback loops run imperatively *inside* nodes because the TS Graph's
AND-dependency semantics deadlock on cyclic edges. Caps/constants: `src/runtime/src/config.ts`.

| Stage | Where | Model | Role |
|---|---|---|---|
| Analyzer | Strands `Agent` in the runtime | Haiku 4.5 | Gate + ticket decomposition: `{suitable, confidence, intent, requirements, acceptanceCriteria, affectedAreas, dependencies, risk, complexity, outstandingQuestions, injectionSuspected}` — intent/requirements feed planner+adversary, risk tunes review rigour, areas+intent feed retrieval, injection suspicion blocks for human review |
| Planner | Claude Code subprocess, plan mode (read-only), over a shallow clone | Opus 4.6 | Explores the repo, produces the plan; retrieved lessons injected |
| Adversary | Strands `Agent` in the runtime | Haiku 4.5 | Refutes plan vs criteria — gaps AND scope creep are blocking; objections revise the plan via `claude --resume` (cap: 2 rounds) |
| Implementer | Claude Code in CodeBuild `claude-code-executor` | Opus 4.6 | Implements the plan (lessons appended); hard gates (typecheck, tests) before branch push + PR |
| Reviewer | Claude Code subprocess, fresh context | Opus 4.6 | Blind review of the PR diff (findings format is guarded: unparseable output retries once, then fails loudly), then a phase-2 lesson check; blocking findings → one revision build (cap: 1); unresolved findings or an implementer "no-changes" disagreement are posted to the PR for the human |
| Curator | Strands `Agent` in the runtime | Haiku 4.5 | Terminal node: persists findings, distills lessons — see `docs/specs/learning-loop.md` |

## Trigger and feedback

Linear webhook (team-scoped) → Lambda `etrm-factory-trigger`: HMAC verify → fire only on
the *transition* to the `agent-ready` label, skip if `agent-in-progress` → DynamoDB
conditional claim (`etrm-factory-runs`, 2h TTL — exactly one delivery per issue wins) →
`InvokeAgentRuntime` (async-accept: the runtime registers an AgentCore async task and
returns immediately). Every exit path writes back to Linear: questions + `agent-blocked`,
PR link, or a truncated failure message — no silent deaths.

## Security model

Full specification: `docs/specs/security.md`. Essentials: Claude Code sessions run under
the bedrock-only assumed role with ambient creds stripped; workspaces are credential-less
(only harness steps push, to `agent/*` only); ticket content is delimited as untrusted
data with an analyzer injection tripwire; one fresh `runtimeSessionId` per run is the
isolation boundary; the pipeline ends at a human-reviewed PR — never auto-merge.

## Operational controls

- **Budget**: per-run LLM token cap (`maxRunTokens`) aborts before plan revisions and
  revision builds; per-stage/graph timeouts in config.
- **Observability**: OTEL traces (ADOT preload → `aws/spans`, GenAI observability;
  `issue.id` on every graph trace); EMF metrics namespace `EtrmFactory/Pipeline` (runs,
  durations, tokens by stage); dashboard `etrm-factory-pipeline`; alarm
  `etrm-factory-pipeline-failed` → SNS `etrm-factory-alerts`.
- **Evals before deploy**: `e2e/run-evals.sh` runs the graded ticket set against the
  deployed runtime, scores deterministically, commits scorecards to `e2e/evals/results/`.

## AWS resource inventory (ap-southeast-2)

| Resource | Name |
|---|---|
| AgentCore runtime | `etrm_factory_pipeline-WNJDR0HSAQ` |
| AgentCore memory store | `etrm_factory_lessons-Zv1mYYATxG` |
| Webhook Lambda (+ function URL) | `etrm-factory-trigger` |
| CodeBuild project | `claude-code-executor` (custom ARM image `etrm-factory-codebuild`) |
| ECR repos | `etrm-factory-runtime`, `etrm-factory-codebuild` |
| S3 | `etrmfactory-agent-artifacts-007460876082` (plans, Claude transcripts) |
| DynamoDB | `etrm-factory-runs` (idempotency), `etrm-factory-findings` (findings archive) |
| SNS / CloudWatch | `etrm-factory-alerts`; dashboard + alarm as above |
| IAM roles | `etrm-factory-runtime-role`, `claude-code-executor-role`, `etrm-factory-trigger-role`, `etrm-agent-bedrock-only` |

Provisioning is all in `infra/scripts/` (re-runnable); policies in `infra/iam/`.

## Diagram

Published artifact: https://claude.ai/code/artifact/78c140cf-f531-4adf-aac0-01af21d36353

## Design principles

- Deterministic orchestration — no LLM decides routing; edge conditions are plain functions.
- Independent contexts per stage — the reviewer never shares a session with the implementer;
  the only cross-run channel is curated lessons.
- Bounded loops with honest exits — on a cap hit or disagreement, proceed and escalate to
  the human rather than looping or lying.
- Verification is mechanical where possible — buildspec gates run regardless of what the
  model claims.

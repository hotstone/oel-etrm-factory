# etrm-factory — agent pipeline

Linear-ticket-to-PR pipeline on AWS Bedrock AgentCore. See README.md for the architecture.
This file is for working on the pipeline itself.

## Commands

- `cd src/runtime && npm run typecheck` — strict TS check; run after any runtime change.
- `cd src/runtime && npm test` — unit tests (vitest); they also gate the Docker image
  build, so a failing test blocks deploys.
- `cd src/runtime && npm run dev -- HOT-nn` — run the whole pipeline locally against a Linear
  issue (real side effects: Linear comments/labels, CodeBuild spend, PRs on the test repo).
- `infra/scripts/deploy-runtime.sh` — build/push image + update the AgentCore runtime. Required
  after any `src/runtime/src` change; local runs do NOT update the deployed runtime.
- `infra/scripts/create-codebuild.sh` — push `infra/codebuild/buildspec.yml` changes to the CodeBuild project.
- `infra/scripts/deploy-trigger.sh` — deploy the webhook Lambda.

## Evals before deploy

Run `e2e/run-evals.sh` (or `cd src/runtime && npm run eval -- [caseId ...]`) before
deploying prompt/model/graph changes. It runs the graded ticket set in
`e2e/evals/cases.json` through the DEPLOYED runtime, scores deterministically, writes a
scorecard to `e2e/evals/results/`, and cleans up its Linear issues/PRs/branches. A full
sweep costs real money (one pipeline run per pr-expected case).

## Terminology

The plan critic is the **adversary** (adversarial review). Do not introduce "antagonist".

## Key facts and constants

- All IDs, model profiles, labels, caps live in `src/runtime/src/config.ts` — change there, nowhere else.
- Models are Bedrock **`au.` inference profile IDs**; bare `anthropic.*` model IDs are
  rejected in ap-southeast-2. Only Opus 4.6 / Sonnet 4.6/4.5 / Haiku 4.5 are granted.
- `prod/linear/apikey` is JSON-wrapped (`{"api-key": ...}`); `prod/github/pat` is a plain string.
- The pipeline targets one repo (`hotstone/oel-factory-testproject`), hardcoded in config.

## Gotchas (each cost a debugging cycle — don't rediscover them)

- **Strands TS Graph uses AND-dependency semantics**: a node waits for ALL incoming edges,
  so cyclic feedback edges deadlock on first execution. Loops (plan⇄adversary,
  review⇄revision) run imperatively inside `StepNode` functions with caps from config.
- **Strands imports**: `Node`, `Graph`, and multiagent types come from
  `@strands-agents/sdk/multiagent`, not the package root.
- **CodeBuild buildspec**: commands run under **dash, not bash** (no `set -o pipefail`);
  a plain YAML scalar containing `: ` (colon-space) becomes a mapping — quote the command.
- **Claude Code in CodeBuild runs as root**: `--dangerously-skip-permissions` needs
  `IS_SANDBOX=1` in the environment.
- **Claude subprocesses**: pipe prompts via **stdin**, never argv (arg limits; failed
  commands echo the whole prompt into error messages).
- **Linear API JSON** can contain raw control characters inside strings; parse leniently.
- **IAM propagation**: newly created roles fail validation in downstream create calls for
  ~10–20s; the setup scripts are re-runnable — just re-run on that error.
- The webhook Lambda fires only on the **transition** to `agent-ready` and skips issues
  labelled `agent-in-progress`.
- **One run = one fresh `runtimeSessionId` — this is the isolation boundary.** Each
  unique session ID gets its own AgentCore microVM (own filesystem, memory), destroyed
  and sanitized at session end. Never reuse session IDs across issues or clients: Claude
  Code state in `$HOME/.claude` (plans, transcripts) would bleed between them. Never
  enable AgentCore session storage for this runtime — same hole, different door. If
  warm-start latency ever matters, solve it another way.

## Lessons memory (Phase 2)

- Store `etrm_factory_lessons-Zv1mYYATxG` (AgentCore Memory, semantic strategy
  `lessons-5besGmFODm`); config in `src/runtime/src/config.ts` → `memory`. Direct record
  writes (`BatchCreateMemoryRecords`) need the strategyId AND namespace; retrieval scores
  sit ~0.4–0.5 even for clearly related queries — don't raise the floor casually.
- The curator's echo guard is code-enforced in the curate node: findings tagged
  `[lesson:<id>]` may only reinforce; never let the LLM decide that.
- Findings persist to DynamoDB `etrm-factory-findings` on every review exit; persistence
  and memory calls are best-effort and must never fail the pipeline.

## Observability

- Tracing rides on **ADOT JS preloaded in the Dockerfile CMD** (`node --require
  @aws/.../register`), activated by `AGENT_OBSERVABILITY_ENABLED=true` (set by
  deploy-runtime.sh). ADOT owns the global tracer provider and SigV4-signs spans
  to CloudWatch; AgentCore injects **no** OTLP endpoint and runs **no** local
  collector, so a vanilla OTLP exporter silently exports to nowhere. Never call
  Strands' `setupTracer` when ADOT is active (see `src/telemetry.ts`).
- Strands' telemetry module imports the OTEL metrics exporter top-level — the
  `@opentelemetry/*` deps in package.json are all required at boot.
- Spans land in the `aws/spans` log group (CloudWatch GenAI observability /
  Transaction Search); filter by `service.name = etrm_factory_pipeline.DEFAULT`.

## Conventions

- **Claude sessions run under the bedrock-only role.** Both the buildspec and
  `src/claude.ts` assume `etrm-agent-bedrock-only` and hand the subprocess ONLY those
  creds, stripping the container role's credential source from its env. Never give a
  claude subprocess ambient role creds.
- **Workspaces are credential-less.** Claude Code sessions (runtime clone and CodeBuild)
  must never hold the GitHub PAT: remotes are scrubbed after clone, the PAT lives in
  unexported shell vars / prefix assignments, and only deterministic harness steps push.
  Preserve this in any buildspec or workspace change.

- **Every TypeScript change ships with appropriate unit tests.** Pure/deterministic
  logic (parsers, predicates, formatters, mappers) gets direct tests in
  `src/runtime/test/`; extract logic from I/O wrappers when needed to make it testable
  (see parseLenientJson, outcomeFromComments, shouldFire for the pattern). Prompt
  *effectiveness* is the eval harness's job, not unit tests'. Linear comment templates
  live ONLY in `src/comments.ts` — eval recovery matches on those prefixes.
- **Specs update in the same commit as the change.** Anything that alters the graph
  shape, an agent's role, the security model, operational controls, or the AWS resource
  set must update `docs/specs/` (pipeline.md, learning-loop.md, pipeline-diagram.html)
  alongside the code. The backlog records *that* something changed; the specs describe
  the system as it now is — don't let the backlog become the only record.
- Setup/deploy scripts are idempotent and re-runnable; keep them that way.
- IAM policies are checked-in JSON under `infra/iam/` — never console-edited.
- Every stage failure must land on the "comment back to Linear" path; no silent deaths.
- The pipeline ends at a PR. Never add auto-merge.

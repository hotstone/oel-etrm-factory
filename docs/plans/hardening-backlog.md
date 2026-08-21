# Hardening backlog (Phase 1 → production readiness)

Grouped by what each item protects. Items marked ★ are the recommended first slice.

## Reliability / correctness

- Webhook idempotency beyond the label guard — Linear redelivers on slow ACKs; the
  `agent-in-progress` label has a seconds-wide race window. DynamoDB idempotency key on
  issue ID, or accept the dupe risk explicitly.
- ✅ Revision-run "no changes" edge (2026-08-21) — a change-less revision run now exports
  AGENT_RESULT=no-changes; the review loop posts an "agent disagreement" comment to the PR
  and completes instead of failing.
- Harden `linear.ts` response parsing — Linear can emit raw control characters inside
  JSON string values.
- Per-stage timeout budget review; ensure every failure path lands on the
  comment-back-to-Linear exit (no silent deaths).

## Prompt quality (both observed in the HOT-53 run)

- ✅ Reviewer output discipline (2026-08-21) — findings-only output, posted verbatim.
- ✅ Adversary scope-creep check (2026-08-21) — work beyond the criteria is a blocking objection.
- Analyzer strictness calibration — measurable now. ✅ Baseline sweep (2026-08-21):
  6/6 effective (5 scored + scope-bait amended after a local network drop mid-invoke;
  verified server-side: clean PR within allowed files). All three gate cases blocked
  correctly, including the unknown-area probe. Harness follow-ups: set maxAttempts=1 on
  the eval invoke client (SDK auto-retry double-ran a pipeline after a network blip) and
  recover outcomes from Linear when the sync connection drops. Known gap probed by the advisory
  `unknown-area` case: the analyzer cannot see the repo, so tickets referencing
  nonexistent components may pass the gate.

## Speed / cost

- ✅ Custom CodeBuild image (2026-08-21) — `etrm-factory-codebuild` ECR image (node 22 +
  Claude Code + AWS CLI, ARM), project switched to ARM_CONTAINER.
- npm cache for the target repo's `npm ci` (CodeBuild local or S3 cache).
- Tighter CodeBuild poll interval; reserved capacity only if volume justifies it.
- Per-run budget cap (cost visibility is done via EMF token metrics; the abort guardrail is not).

## Security / ops

- ✅ GitHub PAT rotated (2026-08-21) — scoped to the target repo, contents + PRs, no admin;
  old token revoked and verified dead.
- Kill switch documented (disable the Linear webhook) — see README.
- ✅ Branch protection: NOT available (private repo on GitHub Free). Compensating control
  (2026-08-21): **credential-scrubbed workspaces** — Claude Code sessions (runtime and
  CodeBuild) get a remote with no embedded credential and no PAT in their environment;
  only deterministic harness steps re-fetch the PAT, and they push only `agent/*` branches.
  ✅ Residual closed by split-role design (2026-08-21): Claude Code sessions (CodeBuild
  and runtime) run under the `etrm-agent-bedrock-only` assumed role — Bedrock invoke and
  nothing else — with the container role's credential source stripped from their env.
  Bedrock permissions are removed from the executor role entirely. (Chained role sessions
  cap at 1h — fine for current session lengths.)
- Stale `agent/*` branch cleanup for failed/abandoned runs.
- ✅ OTEL tracing (2026-08-21) — ADOT JS preload + Strands global-API spans + per-stage
  withSpan bridges; full graph→stage→agent→model-call traces in `aws/spans`
  (CloudWatch GenAI observability). Optional refinement: per-agent span destination via
  `UNIFIED_TRACES_DESTINATION_ENABLED=true` + log-group resource policy.
- ✅ o11y Layer 1 (2026-08-21) — EMF metrics (runs/duration by outcome, per-stage duration + tokens, loop counts), dashboard etrm-factory-pipeline, alarm etrm-factory-pipeline-failed (no SNS action wired yet).

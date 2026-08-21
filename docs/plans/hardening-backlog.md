# Hardening backlog (Phase 1 → production readiness)

Grouped by what each item protects. Items marked ★ are the recommended first slice.

## Reliability / correctness

- Webhook idempotency beyond the label guard — Linear redelivers on slow ACKs; the
  `agent-in-progress` label has a seconds-wide race window. DynamoDB idempotency key on
  issue ID, or accept the dupe risk explicitly.
- Revision-run "no changes" edge — if a revision build's Claude session changes nothing,
  the buildspec's changes-exist gate fails the build and the review loop dies as a
  pipeline *failure* instead of "implementer and reviewer disagree — escalate".
- Harden `linear.ts` response parsing — Linear can emit raw control characters inside
  JSON string values.
- Per-stage timeout budget review; ensure every failure path lands on the
  comment-back-to-Linear exit (no silent deaths).

## Prompt quality (both observed in the HOT-53 run)

- ✅ Reviewer output discipline (2026-08-21) — findings-only output, posted verbatim.
- ✅ Adversary scope-creep check (2026-08-21) — work beyond the criteria is a blocking objection.
- Analyzer strictness calibration over a larger ticket sample.

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
  Residual: the CodeBuild role itself can read the PAT secret (Claude has the role's AWS
  creds for Bedrock), so a determined injected session could fetch it via the AWS CLI —
  closing that needs a split-role design or paid branch protection.
- Stale `agent/*` branch cleanup for failed/abandoned runs.
- ✅ OTEL tracing (2026-08-21) — ADOT JS preload + Strands global-API spans + per-stage
  withSpan bridges; full graph→stage→agent→model-call traces in `aws/spans`
  (CloudWatch GenAI observability). Optional refinement: per-agent span destination via
  `UNIFIED_TRACES_DESTINATION_ENABLED=true` + log-group resource policy.
- ✅ o11y Layer 1 (2026-08-21) — EMF metrics (runs/duration by outcome, per-stage duration + tokens, loop counts), dashboard etrm-factory-pipeline, alarm etrm-factory-pipeline-failed (no SNS action wired yet).

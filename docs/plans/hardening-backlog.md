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

- ★ Reviewer output discipline — working preamble leaked into the PR comment; demand the
  `## Findings` section only.
- ★ Adversary scope-creep check — the out-of-scope function in PR #4 was in the plan the
  adversary approved; add "flag anything beyond the acceptance criteria".
- Analyzer strictness calibration over a larger ticket sample.

## Speed / cost

- ★ Custom CodeBuild image with node + Claude Code preinstalled (~1.5 min/build saved).
- npm cache for the target repo's `npm ci` (CodeBuild local or S3 cache).
- Tighter CodeBuild poll interval; reserved capacity only if volume justifies it.
- Cost telemetry: per-run token + build-minute accounting (graph results carry per-node
  usage), plus a per-run budget cap.

## Security / ops

- ★ Rotate the GitHub PAT (passed through a chat transcript) and reissue with
  contents + pull-requests only (current one has admin).
- Kill switch documented (disable the Linear webhook) — see README.
- ★ Branch protection on `main` in the target repo (mechanically enforces the human gate).
- Stale `agent/*` branch cleanup for failed/abandoned runs.
- Richer observability: AgentCore OTEL tracing beyond CloudWatch logs.

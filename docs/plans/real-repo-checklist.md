# Onboarding a real repository

Runbook for pointing the pipeline at a repo that matters. The test repo skipped several
of these deliberately.

## GitHub

- [ ] **Branch protection on `main`** — require a PR + ≥1 approval, block force-pushes.
  Needs GitHub Pro/Team for a private repo (free on public). This mechanically enforces
  the human gate; without it the gate is procedural only (credential-scrubbed workspaces
  cover the agent side, not the human side).
- [ ] **"Automatically delete head branches"** repo setting — kills merged-branch litter.
- [ ] **Fine-grained PAT** scoped to exactly this repo: Contents R/W, Pull requests R/W,
  Metadata R. No admin. Store via `aws secretsmanager put-secret-value` with `$(pbpaste)`
  (never through a chat or shell-history literal). Update `prod/github/pat`.
- [ ] Repo has: one-command test suite green on `main`, a `CLAUDE.md` (test/build
  commands, conventions, directory guide), PR template (optional).

## Pipeline config (`src/runtime/src/config.ts` + `infra/codebuild/buildspec.yml`)

- [ ] `repo` updated in both places (until multi-repo routing exists).
- [ ] Model tiers reviewed — prefer the newest granted Claude models for the Claude Code
  stages (check `aws bedrock get-foundation-model-availability`).
- [ ] `maxRunTokens` budget sized for the repo (bigger repo → bigger plans/reviews).
- [ ] Loop caps + timeouts sanity-checked against the repo's build/test duration
  (`codebuildTimeoutMs` must exceed clone + npm ci + implement + test comfortably).

## Linear

- [ ] Trigger labels exist in the relevant team; webhook scoped to that team
  (or create a second webhook — the Lambda filters by label transition, not team).
- [ ] Ticket authors briefed: acceptance-criteria style gets PRs; vague tickets get
  questions. The eval cases in `e2e/evals/cases.json` show the calibration.

## Network (decided 2026-08-24: deferred for the test system, REQUIRED before client code)

- [ ] Move the AgentCore runtime off `networkMode: PUBLIC` into the default VPC's three
  private subnets (`172.31.128/144/160.0/20` — currently isolated: no NAT, no endpoints),
  and give CodeBuild the same VPC config. Requires: NAT gateway + private route table
  (~$40/mo) and a security group. This creates the egress chokepoint with a stable IP.
- [ ] Optional hardening on top: AWS Network Firewall domain allowlist (GitHub, Linear,
  AWS endpoints) for actual exfiltration control (~$300+/mo) — decide by client risk.
- [ ] Webhook Lambda: set reserved concurrency (spam/cost cap on the public URL);
  consider API Gateway + WAF if abuse is ever observed.

## Bedrock spend limiting (process, in build order)

- [ ] Application inference profiles (tagged) wrapping the `au.` profiles → per-workload
  cost allocation + per-profile token metrics.
- [ ] Fast circuit-breaker: CloudWatch alarm on our `TokensUsed` EMF metric (tokens/hour)
  → SNS → small Lambda that disables the Linear webhook. Minutes-level containment.
- [ ] AWS Budgets (Bedrock/tag-filtered) with a budget action attaching a deny
  `bedrock:InvokeModel*` policy to `etrm-agent-bedrock-only` + runtime role at threshold.
  Real IAM enforcement, ~8–24h billing lag — caps the month, not the hour.
- [ ] Optional: service-quota reductions (TPM/RPM) via support ticket to bound burn rate.
- Already in place: per-run `maxRunTokens`, build timeouts, failure alarm → SNS.

## Ops

- [ ] SNS: subscribe a real destination to `etrm-factory-alerts`
  (`aws sns subscribe --topic-arn ... --protocol email --notification-endpoint you@...`).
- [ ] Analyzer calibration: add 5–10 anonymized REAL tickets from the team's backlog to
  the eval set with expected outcomes; run a sweep; tune the analyzer prompt until the
  gate matches team expectations.
- [ ] Run one full sweep (`e2e/run-evals.sh`) against the new repo config before
  announcing it.
- [ ] Cost check after the first week: CloudWatch dashboard `etrm-factory-pipeline`
  (tokens/run ≈ cost proxy) + CodeBuild minutes.

## Explicitly out of scope until later

- Multi-repo routing (one pipeline instance per repo until then).
- Concurrency beyond a handful of parallel tickets (executor is a sync bridge).

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

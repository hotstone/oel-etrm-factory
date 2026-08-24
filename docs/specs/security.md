# Security

Controls in place today, and the boundaries they rely on. Deferred items live in
`docs/plans/real-repo-checklist.md`; this file describes the current system only.

## Threat model

- **Untrusted input**: Linear ticket text, titles, and comments — writable by anyone with
  team access, embedded in every stage's prompt. The pipeline exists to act on tickets,
  so a malicious ticket is a legitimate-looking instruction; defense is privilege
  containment plus human gates, not input rejection alone.
- **Fallible-but-trusted**: agent outputs (plans, diffs, findings) — derived from
  untrusted input, checked by gates.
- **Attacker goals, ranked by today's exposure**: code exfiltration via open egress;
  malicious-but-plausible code reaching a rubber-stamped PR; lesson-store poisoning;
  token spend.

## Identity and credentials

| Principal | Holds | Cannot |
|---|---|---|
| Claude Code sessions (runtime + CodeBuild) | `etrm-agent-bedrock-only` assumed-role creds only; ambient credential sources stripped from env | Read secrets, push code, touch any AWS API but Bedrock invoke |
| CodeBuild executor role | Logs, PAT secret, S3 plans, ECR pull, assume bedrock-only | Invoke Bedrock directly |
| Runtime role | Bedrock, CodeBuild start/poll, secrets, S3, DynamoDB, memory store, assume bedrock-only | — (the trusted orchestrator) |
| Trigger Lambda role | Webhook secret, invoke runtime, idempotency-table put | Everything else |

- **Credential-less workspaces**: git remotes scrubbed after clone; the PAT exists only
  in unexported shell vars / prefix assignments; deterministic harness steps push, and
  only to `agent/*` branches.
- GitHub PAT is fine-grained: one repo, Contents + Pull requests, no admin. Secrets in
  Secrets Manager (`prod/linear/apikey` JSON-wrapped, `prod/github/pat` plain,
  `prod/linear/webhook-secret`). IAM policies are checked-in JSON (`infra/iam/`), never
  console-edited.

## Isolation boundaries

- **One run = one fresh `runtimeSessionId`** — the AgentCore isolation boundary: each ID
  gets a dedicated microVM (own filesystem/memory), sanitized at session end. Never reuse
  IDs across issues or clients; never enable AgentCore session storage. Claude Code state
  (`$HOME/.claude`) dies with the run because of this invariant.
- CodeBuild: fresh container per build.
- Lessons memory: namespace per target repo (config-enforced; see tenancy note below).
- Webhook idempotency: DynamoDB conditional claim — one delivery per issue wins.

## Untrusted input and prompt injection

- **Deterministic delimiting** (`src/runtime/src/untrusted.ts`): harness code — never a
  model — wraps ticket text in markers with a standing data-not-instructions notice,
  stripping embedded delimiter look-alikes first so the region cannot be closed early.
- **Analyzer tripwire**: `injectionSuspected` in the assessment schema; suspicion gates
  the graph and posts a distinct "human security review needed" comment to Linear.
- **Reviewer override**: changes that weaken security/validation/secrecy are `[blocking]`
  even when the plan or criteria call for them.
- **Structural limit**: all internal agents take the ticket as their instruction source,
  so a *consistent* poisoning passes internal gates. The two uncorrelated checks are
  human: whoever applies `agent-ready` (restrict this in Linear), and PR review — both
  are security controls, not formalities.
- The `injection` eval case regression-tests the tripwire.

## Ingress and egress

- **Ingress**: one public endpoint — the trigger Lambda's function URL (required: Linear
  must reach it from the internet). Defenses: HMAC signature, label-transition filter,
  idempotency claim. Residual: unauthenticated spam (cost/noise, not forgery).
- **Egress: currently unrestricted** (runtime `networkMode: PUBLIC`, CodeBuild default
  internet). This is the largest open gap — the designed fix (private subnets + NAT
  chokepoint, optional domain filtering) is deferred until real-repo use; see the
  Network section of the real-repo checklist.

## Spend containment

Per-run `maxRunTokens` (harness-enforced, checked before plan revisions and revision
builds), loop caps, build/graph timeouts, failure alarm → SNS. No IAM-level Bedrock cap
exists; the layered process (attribution profiles, EMF circuit-breaker, Budgets deny
action) is documented in the real-repo checklist. Kill switch: disable the Linear webhook.

## Audit

OTEL traces (`aws/spans`, `issue.id` on every graph trace), EMF run/stage metrics,
per-stage summary logs, append-only findings archive with provenance, plans + Claude
transcripts in S3. Gap: no log retention configured yet (client code fragments would
persist indefinitely).

## Tenancy

Single-tenant by construction: one repo, one Linear team, one memory namespace, one PAT.
Every separation that exists between hypothetical tenants is application-level (config),
not IAM-level. Serving multiple clients from this deployment requires a tenancy decision
first (cell-per-client recommended; account-per-client for external parties) — analysis
in the 2026-08-24 review; do not add a second client to this deployment without it.

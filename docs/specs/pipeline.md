# Pipeline architecture

Linear-ticket-to-PR delivery pipeline. Trigger to PR, fully automated; merge is always human.

## Stages

| Stage | Where it runs | Model | Role |
|---|---|---|---|
| Analyzer | AgentCore runtime, Strands `Agent` | Haiku 4.5 | Gate: is the ticket well-specified? Emits structured `{suitable, missingInfo, acceptanceCriteria, affectedAreas}` |
| Planner | Claude Code subprocess in the runtime container (plan mode, read-only) | Opus 4.6 | Explores a shallow clone, produces an implementation plan |
| Adversary | Strands `Agent` | Haiku 4.5 | Refutes the plan against the acceptance criteria; blocking objections send the plan back via `claude --resume` (cap: 2 rounds) |
| Executor | CodeBuild job `claude-code-executor` | Opus 4.6 | Claude Code implements the plan; hard gates (changes exist, typecheck, tests) before branch push + PR |
| Reviewer | Claude Code subprocess in the runtime container | Opus 4.6 | Fresh-context review of the PR diff; blocking findings trigger one revision build; unresolved findings are posted to the PR |

## Orchestration

Strands TS `Graph`: `analyze → plan → implement → review`, conditional edges gate
progression (`suitable`, plan-exists). Feedback loops run imperatively inside the plan and
review nodes because the TS Graph resolves dependencies with AND semantics — cyclic edges
deadlock on first execution. All caps and constants: `src/runtime/src/config.ts`.

## Trigger and feedback

Linear webhook (team-scoped) → Lambda `etrm-factory-trigger`: HMAC verify, fire only on the
*transition* to the `agent-ready` label, skip if `agent-in-progress` → `InvokeAgentRuntime`
(async-accept: the runtime registers an AgentCore async task and returns immediately).
Every exit path writes back to Linear: questions + `agent-blocked`, PR link, or a truncated
failure message.

## Diagram

Published artifact (includes the phase-2 memory loop):
https://claude.ai/code/artifact/78c140cf-f531-4adf-aac0-01af21d36353

## Design principles

- Deterministic orchestration — no LLM decides routing; conditions are plain functions.
- Independent contexts per stage — the reviewer never shares a session with the executor.
- Bounded loops with honest exits — on a cap hit, proceed and escalate to the human.
- Verification is mechanical where possible — the buildspec's test/typecheck gates run
  regardless of what the model claims.
- The pipeline ends at a PR; only humans merge. Never auto-merge. Branch protection is
  unavailable (private repo, GitHub Free) — the compensating control is credential-scrubbed
  workspaces: Claude Code sessions hold no push credential; only deterministic harness
  steps re-fetch the PAT, and they push only `agent/*` branches.

# etrm-factory

An automated **Linear-ticket-to-pull-request pipeline** on AWS Bedrock AgentCore. Apply the
`agent-ready` label to a Linear issue and the pipeline analyzes it, plans against the real
codebase, adversarially critiques the plan, implements it with Claude Code, reviews the diff,
and opens a pull request — or blocks the ticket with clarifying questions. It always ends at
a **human-reviewed PR**, never a merge.

Target repository: [`hotstone/oel-factory-testproject`](https://github.com/hotstone/oel-factory-testproject) (a small
ETRM library used as the test bed). Region: `ap-southeast-2`.

## Flow

```
Linear issue + agent-ready label
  → webhook → Lambda (signature check, label-transition filter)
  → AgentCore Runtime (Strands graph, async-accept)
      analyze   Haiku agent, structured output — suitable? acceptance criteria?
      plan      Claude Code plan-mode session over a clone; adversary critique loop (≤2)
      implement CodeBuild job: Claude Code implements, typecheck+tests gate, branch + PR
      review    fresh Claude Code session over the diff (blind, then a lesson
                check); revision build loop (≤1), unresolved findings posted to the PR
      curate    findings archived; lessons distilled into long-term memory that
                briefs future runs (docs/specs/learning-loop.md)
  → PR link (or questions) commented back on the Linear issue
```

Feedback loops run *inside* the plan and review nodes (the Strands TS Graph resolves
dependencies with AND semantics, so cyclic edges would deadlock). Every loop has a hard cap;
on a cap hit the pipeline proceeds honestly and escalates unresolved findings to the human.

## Repository layout

| Folder | Contents |
|---|---|
| `src/runtime/` | The AgentCore Runtime service (Node/TS): Strands graph, agents, Claude Code wrapper, CodeBuild bridge, Linear/GitHub clients, Dockerfile |
| `src/trigger/` | Linear webhook Lambda (HMAC verify → filter → `InvokeAgentRuntime`) |
| `infra/codebuild/` | `buildspec.yml` for the executor job (inlined into the CodeBuild project) |
| `infra/iam/` | IAM trust/permission policies for the three roles |
| `infra/scripts/` | Re-runnable setup and deploy scripts |
| `e2e/` | Manual end-to-end drivers (`invoke-runtime.sh`, `run-executor.sh`) and plan fixtures |
| `docs/` | `specs/` (architecture) and `plans/` (phase plans, hardening backlog) |

## Operating it

- **Normal use:** add the `agent-ready` label to an issue in the Linear team. Watch the
  issue for `agent-in-progress` → a PR link or questions. Findings the agent review could
  not resolve appear as PR comments.
- **Manual pipeline run:** `e2e/invoke-runtime.sh HOT-53` (synchronous, prints outcome).
- **Local pipeline run:** `cd src/runtime && npm run dev -- HOT-53` (uses your AWS credentials).
- **Executor only, with a handwritten plan:** `e2e/run-executor.sh <ID> <plan.md> <title> <url>`.
- **Kill switch:** disable the webhook in Linear (Settings → API → Webhooks), or delete the
  Lambda function URL.

## Deploying changes

- Runtime (graph/agents/prompts): `infra/scripts/deploy-runtime.sh` — builds the arm64 image,
  pushes to ECR, updates the AgentCore runtime.
- Executor job (buildspec): `infra/scripts/create-codebuild.sh` — re-inlines `infra/codebuild/buildspec.yml`.
- Webhook Lambda: `infra/scripts/deploy-trigger.sh`.

Secrets live in Secrets Manager (`prod/linear/apikey`, `prod/github/pat`,
`prod/linear/webhook-secret`); models are Bedrock `au.` inference profiles configured in
`src/runtime/src/config.ts`.

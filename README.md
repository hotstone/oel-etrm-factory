# etrm-factory

An automated **Linear-ticket-to-pull-request pipeline** on AWS Bedrock AgentCore. Apply the
`agent-ready` label to a Linear issue and the pipeline analyzes it, plans against the real
codebase, adversarially critiques the plan, implements it with Claude Code, reviews the diff,
and opens a pull request — or blocks the ticket with clarifying questions. It always ends at
a **human-reviewed PR**, never a merge.

Target repository: [`hotstone/etrmfactory`](https://github.com/hotstone/etrmfactory) (a small
ETRM library used as the test bed). Region: `ap-southeast-2`.

## Flow

```
Linear issue + agent-ready label
  → webhook → Lambda (signature check, label-transition filter)
  → AgentCore Runtime (Strands graph, async-accept)
      analyze   Haiku agent, structured output — suitable? acceptance criteria?
      plan      Claude Code plan-mode session over a clone; adversary critique loop (≤2)
      implement CodeBuild job: Claude Code implements, typecheck+tests gate, branch + PR
      review    fresh Claude Code session over the diff; revision build loop (≤1),
                unresolved findings posted to the PR
  → PR link (or questions) commented back on the Linear issue
```

Feedback loops run *inside* the plan and review nodes (the Strands TS Graph resolves
dependencies with AND semantics, so cyclic edges would deadlock). Every loop has a hard cap;
on a cap hit the pipeline proceeds honestly and escalates unresolved findings to the human.

## Repository layout

| Folder | Contents |
|---|---|
| `runtime/` | The AgentCore Runtime service (Node/TS): Strands graph, agents, Claude Code wrapper, CodeBuild bridge, Linear/GitHub clients, Dockerfile |
| `trigger/` | Linear webhook Lambda (HMAC verify → filter → `InvokeAgentRuntime`) |
| `codebuild/` | `buildspec.yml` for the executor job (inlined into the CodeBuild project) |
| `infra/iam/` | IAM trust/permission policies for the three roles |
| `scripts/` | Re-runnable setup, deploy, and manual-trigger scripts |
| `plans/` | Handwritten plan fixtures for exercising the executor directly |

## Operating it

- **Normal use:** add the `agent-ready` label to an issue in the Linear team. Watch the
  issue for `agent-in-progress` → a PR link or questions. Findings the agent review could
  not resolve appear as PR comments.
- **Manual pipeline run:** `scripts/invoke-runtime.sh HOT-53` (synchronous, prints outcome).
- **Local pipeline run:** `cd runtime && npm run dev -- HOT-53` (uses your AWS credentials).
- **Executor only, with a handwritten plan:** `scripts/run-executor.sh <ID> <plan.md> <title> <url>`.
- **Kill switch:** disable the webhook in Linear (Settings → API → Webhooks), or delete the
  Lambda function URL.

## Deploying changes

- Runtime (graph/agents/prompts): `scripts/deploy-runtime.sh` — builds the arm64 image,
  pushes to ECR, updates the AgentCore runtime.
- Executor job (buildspec): `scripts/create-codebuild.sh` — re-inlines `codebuild/buildspec.yml`.
- Webhook Lambda: `scripts/deploy-trigger.sh`.

Secrets live in Secrets Manager (`prod/linear/apikey`, `prod/github/pat`,
`prod/linear/webhook-secret`); models are Bedrock `au.` inference profiles configured in
`runtime/src/config.ts`.

# The learning loop

How the pipeline learns from its own review cycles so it doesn't make the same mistake
twice. Implemented 2026-08-24; design history in `docs/plans/phase-2-memory.md`.

## The three memory layers

| Layer | Where | Lifespan | Contents |
|---|---|---|---|
| Run context (working memory) | In-process `RunContext` + Claude Code session state | One run, discarded — **by design** | Assessment, plan, critiques, review passes, session ids |
| Findings archive | DynamoDB `etrm-factory-findings` | Permanent, **append-only** | Every reviewer finding verbatim, with provenance: issue, PR, review pass, severity, resolution, files |
| Lessons (long-term memory) | AgentCore Memory `etrm_factory_lessons-Zv1mYYATxG` | Permanent, cross-run | Only curator-distilled, generalized rules; semantically searchable; namespace per target repo (`/lessons/<repo-slug>`) |

Data flow, per run:

```
findings born in run context
  → archived raw to DynamoDB (every review exit path, with final resolution)
  → distilled by the curator into lessons (same run, terminal graph node)
  → run context discarded
```

**The only sanctioned cross-run channel is curated lessons.** A run's plan, diff, and
reasoning never reach the next run; only generalized rules do — each injected lesson
arrives tagged with its record id, relevance-filtered, and hedged with "verify this still
applies". Fresh context per run (fresh clone, fresh sessions) is what preserves the
fresh-eyes properties of the adversary and reviewer.

## Retrieval contract (deterministic — no LLM decides)

`retrieveLessons(query)` in `src/runtime/src/memory.ts`: semantic search, top-k
(`retrievalTopK`, currently 4), relevance floor (`minRelevance`, currently 0.4 —
observed scores for clearly-related queries run ~0.4–0.5, so raise with care). Injected
as a delimited block via `lessonsBlock()`.

| Consumer | Query | Injection point |
|---|---|---|
| Planner | ticket title + analyzer's intent + description + affected areas | appended to the plan prompt |
| Implementer | the approved plan | appended to the plan payload sent to CodeBuild |
| Reviewer | the PR diff (strongest signal — ground truth of what changed) | phase-2 only, see below |

## Reviewer guards

1. **Blind-first.** Phase 1 review runs with no lessons in context (genuinely blind — a
   separate model call, not prompt sequencing). Phase 2 resumes the same session and asks
   only "do these lessons apply to the diff you just reviewed?", emitting extra findings
   tagged `[lesson:<record-id>]`.
2. **Echo guard (code-enforced, never delegated to the LLM).** In the curate node,
   findings carrying a `[lesson:*]` tag may only *reinforce* that lesson's provenance
   (`lastSeenIssue`/`lastSeenAt`); they can never create or strengthen a lesson. Only
   organically-discovered findings mint new memory. This breaks the
   reviewer→curator→memory→reviewer self-amplification loop.

## Curator contract

Terminal graph node (`curate`), runs on every review outcome (clean, revised-then-clean,
cap-hit, disagreement — cap-hit findings are the highest-value input). A Haiku agent
with structured output decides per organic finding:

- `drop` — one-off slips, no transferable rule (most findings).
- `new_lesson` — generalized rule (modules and behaviours, never ticket numbers),
  written to memory with provenance metadata (`sourceIssue`, `files`, `occurrences`).
- `reinforce` — an existing lesson covers it; refresh its provenance instead of
  duplicating (duplicates poison top-k retrieval). The curator sees pre-fetched similar
  lessons; code verifies the id it names actually exists.

Two-tier policy: if a rule is mechanically checkable, the curator records a
`repoChangeSuggestion` (lint rule / test / CLAUDE.md line) inside the lesson text — a
guarantee beats a reminder. Auto-PRing those changes to the target repo is future work.

Curation failures never fail the run (caught inside the node).

## The findings archive is append-only — the curator does NOT drain it

The curator reads findings from the run context, not from DynamoDB; the table exists to
**outlive** curation:

1. **Audit** — lesson → `sourceIssue` → raw findings explains why any lesson exists (or
   why a finding was dropped).
2. **Reprocessing** — a smarter future curator can rebuild the lesson store from the
   full history; curate-then-delete would make every decision irreversible at the moment
   it's made by the dumbest curator that will ever exist.
3. **Analytics** — finding rates per file, severity distributions, cap-hit frequency,
   analyzer calibration.

Cost is negligible (hundreds of bytes per finding, on-demand billing). No TTL today;
before pointing at a real repo, choose a deliberate retention window (findings quote
review commentary about that repo's code) — a one-line table setting.

## What we deliberately don't use

AgentCore Memory's own short-term layer (events + LLM extraction jobs) is unused: the
curator writes long-term records directly (`BatchCreateMemoryRecords` — requires both
`memoryStrategyId` and namespace). Our extraction logic (generalize/dedupe/echo-guard/
two-tier) is more opinionated than the built-in extractor and stays code-auditable.
The `eventExpiryDuration` on the store configures a layer that is never populated.

## Invariants

- Memory and findings calls are **best-effort**: any failure logs and continues; the
  learning loop must never block or fail a delivery.
- Namespace per target repo — lessons never leak across codebases.
- All ids/knobs live in `src/runtime/src/config.ts` → `memory`; provisioning in
  `infra/scripts/create-memory.sh` (re-runnable).

## Open follow-ups

- Lesson expiry/pruning (metadata exists; nothing prunes stale lessons yet).
- Auto-PRing mechanically-checkable lessons to the target repo.
- Richer analyzer schema (hardening backlog) → sharper planner retrieval queries.
- Findings-table TTL decision before real-repo use.

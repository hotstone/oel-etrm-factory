# Phase 2 — Curator and long-term memory

**STATUS: IMPLEMENTED 2026-08-24 — operational specification now lives in `docs/specs/learning-loop.md`; this file is the design history.** All components below are live and verified:
store `etrm_factory_lessons-Zv1mYYATxG` (semantic strategy `lessons-5besGmFODm`,
namespace `/lessons/<repo-slug>`), findings table `etrm-factory-findings`, retrieval in
all three stages (seed lesson injected at 0.45 relevance in a live run), blind-first
phase-2 review, and the curator (drop / new_lesson / reinforce each demonstrated live,
echo guard code-enforced). Provisioning: `infra/scripts/create-memory.sh`. Config knobs
(topK, relevance floor 0.4): `src/runtime/src/config.ts` → `memory`.

Goal: reviewer findings become durable lessons that brief future runs. Design agreed
2026-08-20 (see the diagram in `docs/specs/pipeline.md`).

## Components

1. **Curator node** — terminal graph node after the review loop exits (both paths:
   approved *and* cap-hit; unresolved cap-hit findings are the highest-value lessons).
   Distills findings before writing:
   - generalize (transferable rule, not the ticket-specific instance);
   - dedupe against existing memory (reinforce/update rather than near-duplicate — dupes
     poison top-k retrieval);
   - filter (one-off nits don't get remembered);
   - record provenance (ticket ID, date, files) so lessons can be audited and expired.
2. **Memory store** — AgentCore Memory, long-term records with semantic search, namespace
   per target repo. Strands has native integration; retrieval goes through boto3/SDK.
3. **Retrieval (deterministic code, not an agent)** — three consumers, one lesson used
   three ways (defense in depth: planner avoids designing the mistake in, implementer
   avoids writing it, reviewer catches it if it slipped through):
   - before the planner: query = ticket summary + affected areas from the analyzer;
   - before the executor: query = the approved plan (better signal: real file names);
     inject as a lessons file written into the workspace/plan for Claude Code;
   - before the reviewer: query = **the diff** (the strongest signal of the three — the
     ground truth of what changed). Same lessons-file injection as the executor.
   - top 3–5 above a similarity threshold, clearly delimited, with a "verify each still
     applies" hedge.

## Reviewer-specific guards

The reviewer is both the best retrieval consumer (its query is the actual diff) and the
memory's *source*, which creates two hazards; both have prompt/curator-level fixes:

1. **Anchoring vs fresh eyes.** Injected lessons must not displace the independent pass.
   Sequence the review prompt: *phase 1 — review the diff blind and record findings;
   phase 2 — additionally verify each injected lesson against the diff, reporting only
   ones that actually apply.* Recall boost without contaminating the unprimed pass.
   (Priming implementer and reviewer with the same known failure modes is desirable
   correlation — both defend the same traps; what stays forbidden is sharing this-run
   session context.)
2. **Echo loop.** reviewer findings → curator → memory → reviewer prompt → findings…
   A lesson could self-amplify regardless of whether the issue still exists. Fix: the
   reviewer tags findings that originated from an injected lesson (e.g.
   `[lesson:<memory-id>]`); the curator may refresh that lesson's last-seen provenance
   but must never create or strengthen a lesson from a finding the lesson itself
   prompted. Only organically-discovered findings mint new memory.

Lessons that are mechanically checkable never reach the reviewer at all — the two-tier
policy routes them to lint rules/tests in the target repo, so reviewer attention is spent
only on the fuzzy, judgment-requiring residue.

## Two-tier lesson policy

Soft/contextual lessons → memory store. Hard, mechanically-checkable lessons → the curator
proposes a repo change instead (lint rule, test, CLAUDE.md addition in the target repo):
a CI check is a guarantee, a memory note is a reminder.

## Prerequisite (done)

Findings persistence was deliberately skipped in Phase 1; it now writes to
`etrm-factory-findings` on every review exit path with full provenance.

## Follow-ups

- Lesson expiry: `occurrences`/`lastSeenAt` metadata exists; nothing prunes stale lessons yet.
- Two-tier hard lessons: repoChangeSuggestion is recorded inside the lesson text; auto-PRing
  lint rules/CLAUDE.md changes to the target repo is future work.
- Analyzer schema enrichment (see hardening backlog) will sharpen the planner retrieval query.

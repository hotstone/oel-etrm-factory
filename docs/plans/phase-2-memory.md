# Phase 2 — Curator and long-term memory

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
3. **Retrieval (deterministic code, not an agent)**:
   - before the planner: query = ticket summary + affected areas from the analyzer;
   - before the executor: query = the approved plan (better signal: real file names);
     inject as a lessons file written into the workspace/plan for Claude Code.
   - top 3–5 above a similarity threshold, clearly delimited, with a "verify each still
     applies" hedge.

## Two-tier lesson policy

Soft/contextual lessons → memory store. Hard, mechanically-checkable lessons → the curator
proposes a repo change instead (lint rule, test, CLAUDE.md addition in the target repo):
a CI check is a guarantee, a memory note is a reminder.

## Prerequisite

Findings persistence was deliberately skipped in Phase 1 (test data only). Phase 2 starts
by persisting reviewer findings with provenance, then backfills the curator over them.

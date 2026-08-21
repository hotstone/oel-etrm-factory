// Evaluation harness: runs the graded ticket set through the DEPLOYED pipeline
// and scores outcomes deterministically. Run before deploying prompt/model/graph
// changes ("evals before deploy"). Costs real money (~1 full pipeline run per
// pr-expected case). Usage:  npm run eval  [caseId ...]
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { CONFIG } from "./config.js";
import { closePrAndBranch, fetchPrFiles } from "./github.js";
import { archiveIssue, commentOnIssue, createIssue } from "./linear.js";
import type { PipelineOutcome } from "./pipeline.js";

interface EvalCase {
  id: string;
  expected: "pr" | "blocked";
  advisory?: boolean;
  allowedFiles?: string[];
  title: string;
  body: string;
}

interface CaseResult {
  id: string;
  issue: string;
  expected: string;
  outcome: string;
  pass: boolean;
  advisory: boolean;
  notes: string[];
  durationMs: number;
  prUrl?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const RUNTIME_ARN = `arn:aws:bedrock-agentcore:${CONFIG.region}:007460876082:runtime/etrm_factory_pipeline-WNJDR0HSAQ`;

const agentcore = new BedrockAgentCoreClient({
  region: CONFIG.region,
  requestHandler: { requestTimeout: 45 * 60_000 },
  // Never auto-retry a sync pipeline invoke: a retry after a dropped connection
  // starts a SECOND full pipeline run (observed with a local DNS flake).
  maxAttempts: 1,
});

async function invokePipeline(issueId: string): Promise<PipelineOutcome> {
  const resp = await agentcore.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      runtimeSessionId: `eval-${Date.now()}-${randomBytes(10).toString("hex")}`,
      contentType: "application/json",
      accept: "application/json",
      payload: JSON.stringify({ issueId, sync: true }),
    }),
  );
  const body = await resp.response?.transformToString();
  if (!body) throw new Error("empty runtime response");
  return JSON.parse(body) as PipelineOutcome;
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  const start = Date.now();
  const notes: string[] = [];
  const issue = await createIssue(`[eval:${c.id}] ${c.title}`, c.body);
  console.log(`\n=== ${c.id} → ${issue.identifier} (expected: ${c.expected}) ===`);

  let outcome: PipelineOutcome;
  try {
    outcome = await invokePipeline(issue.identifier);
  } catch (err) {
    outcome = { status: "failed", issue: issue.identifier, detail: String(err) };
  }
  console.log(`outcome: ${outcome.status} ${outcome.prUrl ?? ""} ${outcome.detail}`);

  let pass = false;
  if (c.expected === "blocked") {
    pass = outcome.status === "blocked";
    if (!pass) notes.push(`expected blocked, got ${outcome.status}`);
  } else {
    pass = outcome.status === "completed" && Boolean(outcome.prUrl);
    if (!pass) notes.push(`expected pr, got ${outcome.status}: ${outcome.detail}`);
    if (pass && c.allowedFiles) {
      const prNumber = outcome.prUrl!.split("/").pop()!;
      const files = await fetchPrFiles(prNumber);
      const outside = files.filter((f) => !c.allowedFiles!.includes(f));
      if (outside.length) {
        pass = false;
        notes.push(`diff outside allowed files: ${outside.join(", ")}`);
      }
    }
    if (outcome.detail?.includes("unresolved finding")) notes.push("review left unresolved findings");
  }

  // Cleanup: close the PR + branch, note and archive the eval issue.
  if (outcome.prUrl) {
    const prNumber = outcome.prUrl.split("/").pop()!;
    await closePrAndBranch(prNumber, `agent/${issue.identifier}`).catch((e) => notes.push(`cleanup: ${e}`));
  }
  await commentOnIssue(issue.id, `Eval case \`${c.id}\`: ${pass ? "PASS" : "FAIL"} (${outcome.status})`).catch(() => {});
  await archiveIssue(issue.id).catch((e) => notes.push(`archive: ${e}`));

  return {
    id: c.id,
    issue: issue.identifier,
    expected: c.expected,
    outcome: outcome.status,
    pass,
    advisory: Boolean(c.advisory),
    notes,
    durationMs: Date.now() - start,
    prUrl: outcome.prUrl,
  };
}

const { cases } = JSON.parse(readFileSync(join(repoRoot, "e2e/evals/cases.json"), "utf8")) as { cases: EvalCase[] };
const filter = process.argv.slice(2);
const selected = filter.length ? cases.filter((c) => filter.includes(c.id)) : cases;
if (!selected.length) {
  console.error(`no matching cases; available: ${cases.map((c) => c.id).join(", ")}`);
  process.exit(1);
}

const results: CaseResult[] = [];
for (const c of selected) {
  try {
    results.push(await runCase(c));
  } catch (err) {
    // Infra failure (network, API outage) — record it, keep sweeping.
    console.error(`case ${c.id} infra failure:`, err);
    results.push({
      id: c.id,
      issue: "n/a",
      expected: c.expected,
      outcome: "infra-error",
      pass: false,
      advisory: Boolean(c.advisory),
      notes: [String(err).slice(0, 300)],
      durationMs: 0,
    });
  }
}

const failures = results.filter((r) => !r.pass && !r.advisory);
const advisoryFails = results.filter((r) => !r.pass && r.advisory);
const scorecard = {
  ranAt: new Date().toISOString(),
  passed: results.filter((r) => r.pass).length,
  failed: failures.length,
  advisoryFailed: advisoryFails.length,
  totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
  results,
};

const outDir = join(repoRoot, "e2e/evals/results");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${scorecard.ranAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(outFile, JSON.stringify(scorecard, null, 2));

console.log(`\n=== scorecard ===`);
for (const r of results) {
  console.log(`${r.pass ? "PASS" : r.advisory ? "FAIL (advisory)" : "FAIL"}  ${r.id}  [${r.outcome}] ${Math.round(r.durationMs / 1000)}s ${r.notes.join("; ")}`);
}
console.log(`written: ${outFile}`);
process.exit(failures.length ? 1 : 0);

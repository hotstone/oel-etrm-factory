// Local test entry: run the pipeline directly against an issue without the
// AgentCore runtime wrapper. Usage: npm run dev -- HOT-50
import { runPipeline } from "./pipeline.js";

const issueId = process.argv[2];
if (!issueId) {
  console.error("usage: npm run dev -- <ISSUE_ID>");
  process.exit(1);
}

const outcome = await runPipeline(issueId);
console.log(JSON.stringify(outcome, null, 2));
process.exit(outcome.status === "failed" ? 1 : 0);

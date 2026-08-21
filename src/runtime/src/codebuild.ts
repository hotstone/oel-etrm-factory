import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from "@aws-sdk/client-codebuild";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CONFIG } from "./config.js";

const codebuild = new CodeBuildClient({ region: CONFIG.region });
const s3 = new S3Client({ region: CONFIG.region });

export interface ExecutorRun {
  prUrl: string;
  prNumber: string;
  buildId: string;
  /** "success" or "no-changes" (revision runs where the implementer disagreed). */
  agentResult: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Upload a plan and run the claude-code-executor CodeBuild job to completion.
 * Throws if the build fails (which includes Claude making no changes, or
 * typecheck/test gates failing).
 */
export async function runExecutorBuild(input: {
  issueId: string;
  issueTitle: string;
  issueUrl: string;
  plan: string;
  runLabel: string; // e.g. "initial", "revision-1" — distinguishes S3 keys
}): Promise<ExecutorRun> {
  const key = `plans/${input.issueId}/${Date.now()}-${input.runLabel}/plan.md`;
  await s3.send(
    new PutObjectCommand({ Bucket: CONFIG.artifactsBucket, Key: key, Body: input.plan }),
  );

  const start = await codebuild.send(
    new StartBuildCommand({
      projectName: CONFIG.codebuildProject,
      environmentVariablesOverride: [
        { name: "ISSUE_ID", value: input.issueId, type: "PLAINTEXT" },
        { name: "ISSUE_TITLE", value: input.issueTitle, type: "PLAINTEXT" },
        { name: "ISSUE_URL", value: input.issueUrl, type: "PLAINTEXT" },
        { name: "PLAN_S3_URI", value: `s3://${CONFIG.artifactsBucket}/${key}`, type: "PLAINTEXT" },
        { name: "RUN_LABEL", value: input.runLabel, type: "PLAINTEXT" },
      ],
    }),
  );
  const buildId = start.build?.id;
  if (!buildId) throw new Error("StartBuild returned no build id");

  const deadline = Date.now() + CONFIG.limits.codebuildTimeoutMs;
  for (;;) {
    await sleep(CONFIG.limits.codebuildPollMs);
    const resp = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = resp.builds?.[0];
    const status = build?.buildStatus;
    if (status && status !== "IN_PROGRESS") {
      if (status !== "SUCCEEDED") {
        throw new Error(`executor build ${buildId} finished with status ${status}`);
      }
      const exported = new Map(
        (build?.exportedEnvironmentVariables ?? []).map((v) => [v.name, v.value]),
      );
      const prUrl = exported.get("PR_URL");
      const prNumber = exported.get("PR_NUMBER");
      const agentResult = exported.get("AGENT_RESULT") ?? "success";
      if (!prUrl || !prNumber) throw new Error(`build ${buildId} succeeded but exported no PR info`);
      return { prUrl, prNumber, buildId, agentResult };
    }
    if (Date.now() > deadline) throw new Error(`executor build ${buildId} timed out`);
  }
}

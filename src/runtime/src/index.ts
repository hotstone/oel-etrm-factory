import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";
import { runPipeline } from "./pipeline.js";
import { initTelemetry } from "./telemetry.js";

// Diagnostic: surface what observability plumbing the runtime injects.
const otelEnv = Object.entries(process.env)
  .filter(([k]) => /^OTEL|OBSERVABILITY|ADOT|XRAY/i.test(k))
  .map(([k, v]) => `${k}=${v}`);
console.log(`observability env: ${otelEnv.length ? otelEnv.join(" | ") : "(none injected)"}`);

const tracing = initTelemetry();
console.log(`otel tracing mode: ${tracing}`);

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({
      issueId: z.string().describe("Linear issue identifier, e.g. HOT-50"),
      // sync=true (CLI/testing): hold the invocation open and return the outcome.
      // sync absent/false (webhook path): accept immediately and run in the
      // background — an async task keeps /ping busy so AgentCore doesn't
      // recycle the container mid-pipeline. All results land on Linear/GitHub.
      sync: z.boolean().optional(),
    }),
    process: async (request) => {
      if (request.sync) {
        const outcome = await runPipeline(request.issueId);
        console.log(`pipeline outcome for ${request.issueId}:`, JSON.stringify(outcome));
        return outcome;
      }
      const taskId = app.addAsyncTask(`pipeline-${request.issueId}`);
      void runPipeline(request.issueId)
        .then((outcome) =>
          console.log(`pipeline outcome for ${request.issueId}:`, JSON.stringify(outcome)),
        )
        .catch((err) => console.error(`pipeline crashed for ${request.issueId}:`, err))
        .finally(() => app.completeAsyncTask(taskId));
      return { accepted: true, issue: request.issueId };
    },
  },
});

app.run();

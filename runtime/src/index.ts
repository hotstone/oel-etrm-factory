import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";
import { runPipeline } from "./pipeline.js";

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({
      issueId: z.string().describe("Linear issue identifier, e.g. HOT-50"),
    }),
    process: async (request) => {
      const outcome = await runPipeline(request.issueId);
      console.log(`pipeline outcome for ${request.issueId}:`, JSON.stringify(outcome));
      return outcome;
    },
  },
});

app.run();

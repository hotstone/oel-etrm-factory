// Linear webhook -> AgentCore pipeline trigger.
// Fast path: verify HMAC signature, filter to "agent-ready label was added",
// invoke the runtime in async mode (returns immediately), ACK Linear.
import { createHmac, timingSafeEqual } from "node:crypto";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { ConditionalCheckFailedException, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const REGION = "ap-southeast-2";
const RUNTIME_ARN = process.env.RUNTIME_ARN;
const WEBHOOK_SECRET_ID = process.env.WEBHOOK_SECRET_ID ?? "prod/linear/webhook-secret";
const AGENT_READY_LABEL = "73c75ba5-3ef4-4517-aaaf-573fdd3cc41b";
const AGENT_IN_PROGRESS_LABEL = "46bd9a14-51e1-4434-a097-2fa43cdf1cac";

const agentcore = new BedrockAgentCoreClient({ region: REGION });
const secrets = new SecretsManagerClient({ region: REGION });
const dynamo = new DynamoDBClient({ region: REGION });
const RUNS_TABLE = process.env.RUNS_TABLE ?? "etrm-factory-runs";
let cachedSecret;

async function webhookSecret() {
  if (!cachedSecret) {
    const resp = await secrets.send(new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ID }));
    cachedSecret = resp.SecretString;
  }
  return cachedSecret;
}

const ok = (detail) => ({ statusCode: 200, body: JSON.stringify(detail) });

export async function handler(event) {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");

  // Verify Linear's HMAC-SHA256 signature over the raw body.
  const signature = event.headers?.["linear-signature"];
  if (!signature) return { statusCode: 401, body: "missing signature" };
  const expected = createHmac("sha256", await webhookSecret()).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { statusCode: 401, body: "bad signature" };
  }

  const payload = JSON.parse(rawBody);
  if (payload.type !== "Issue" || !["create", "update"].includes(payload.action)) {
    return ok({ skipped: "not an issue create/update" });
  }

  const labels = payload.data?.labelIds ?? [];
  const previous = payload.updatedFrom?.labelIds; // present only when labels changed

  // Fire only on the transition to agent-ready, and never while a run is in flight.
  const hasReady = labels.includes(AGENT_READY_LABEL);
  const hadReady = Array.isArray(previous) && previous.includes(AGENT_READY_LABEL);
  const inProgress = labels.includes(AGENT_IN_PROGRESS_LABEL);
  const readyAdded =
    hasReady && (payload.action === "create" || (Array.isArray(previous) && !hadReady));
  if (!readyAdded || inProgress) {
    return ok({ skipped: "no agent-ready transition", issue: payload.data?.identifier });
  }

  const issueId = payload.data.identifier;

  // Idempotency claim: Linear redelivers webhooks, and the agent-in-progress
  // label guard has a seconds-wide race window. A conditional write makes
  // exactly one delivery win per issue per 2h window.
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: RUNS_TABLE,
        Item: {
          issueId: { S: issueId },
          claimedAt: { S: new Date().toISOString() },
          ttl: { N: String(Math.floor(Date.now() / 1000) + 2 * 3600) },
        },
        ConditionExpression: "attribute_not_exists(issueId)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.log(`duplicate delivery for ${issueId}; skipping`);
      return ok({ skipped: "duplicate delivery", issue: issueId });
    }
    throw err;
  }

  await agentcore.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      runtimeSessionId: `webhook-${payload.data.id}-${Date.now()}`,
      contentType: "application/json",
      accept: "application/json",
      payload: JSON.stringify({ issueId }),
    }),
  );
  console.log(`pipeline accepted for ${issueId}`);
  return ok({ accepted: issueId });
}

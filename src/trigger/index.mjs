// Linear webhook -> AgentCore pipeline trigger.
// Fast path: verify HMAC signature, filter to "agent-ready label was added",
// invoke the runtime in async mode (returns immediately), ACK Linear.
import { createHmac, timingSafeEqual } from "node:crypto";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { ConditionalCheckFailedException, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { shouldFire } from "./filter.mjs";

const REGION = "ap-southeast-2";
const RUNTIME_ARN = process.env.RUNTIME_ARN;
const WEBHOOK_SECRET_ID = process.env.WEBHOOK_SECRET_ID ?? "prod/linear/webhook-secret";
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
  const decision = shouldFire(payload);
  if (!decision.fire) {
    return ok({ skipped: decision.reason, issue: payload.data?.identifier });
  }

  const issueId = payload.data.identifier;

  // Idempotency claim: Linear sends several events per label mutation and
  // redelivers on failure, and the agent-in-progress label guard has a
  // seconds-wide race window. A conditional write makes exactly one delivery
  // win per issue while a claim is live.
  //
  // The claim is compared against expiresAt rather than relying on the ttl
  // attribute: DynamoDB TTL deletion is lazy (hours late), so an expired claim
  // must still be takeable. The runtime shortens expiresAt when a run reaches a
  // terminal state, so answering a blocked ticket and re-labelling it starts a
  // new run in minutes instead of waiting out the full window.
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: RUNS_TABLE,
        Item: {
          issueId: { S: issueId },
          claimedAt: { S: new Date().toISOString() },
          expiresAt: { N: String(nowSec + 2 * 3600) },
          ttl: { N: String(nowSec + 2 * 3600) },
        },
        // attribute_not_exists(#e) makes any claim written before this format
        // self-healing rather than permanently stuck.
        ConditionExpression:
          "attribute_not_exists(issueId) OR attribute_not_exists(#e) OR #e < :now",
        ExpressionAttributeNames: { "#e": "expiresAt" },
        ExpressionAttributeValues: { ":now": { N: String(nowSec) } },
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

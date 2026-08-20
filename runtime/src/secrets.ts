import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CONFIG } from "./config.js";

const client = new SecretsManagerClient({ region: CONFIG.region });
const cache = new Map<string, string>();

async function getSecret(id: string): Promise<string> {
  const cached = cache.get(id);
  if (cached) return cached;
  const resp = await client.send(new GetSecretValueCommand({ SecretId: id }));
  if (!resp.SecretString) throw new Error(`secret ${id} has no string value`);
  cache.set(id, resp.SecretString);
  return resp.SecretString;
}

export async function linearApiKey(): Promise<string> {
  const raw = await getSecret(CONFIG.secrets.linearApiKey);
  const parsed = JSON.parse(raw) as Record<string, string>;
  const key = parsed["api-key"];
  if (!key) throw new Error(`secret ${CONFIG.secrets.linearApiKey} missing "api-key" field`);
  return key;
}

export async function githubPat(): Promise<string> {
  return getSecret(CONFIG.secrets.githubPat);
}

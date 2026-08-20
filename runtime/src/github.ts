import { CONFIG } from "./config.js";
import { githubPat } from "./secrets.js";

async function gh(path: string, init?: RequestInit & { accept?: string }): Promise<Response> {
  const pat = await githubPat();
  const resp = await fetch(`https://api.github.com/repos/${CONFIG.repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: init?.accept ?? "application/vnd.github+json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!resp.ok) throw new Error(`GitHub API ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp;
}

export async function fetchPrDiff(prNumber: string): Promise<string> {
  const resp = await gh(`/pulls/${prNumber}`, { accept: "application/vnd.github.diff" });
  return resp.text();
}

export async function commentOnPr(prNumber: string, body: string): Promise<void> {
  await gh(`/issues/${prNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

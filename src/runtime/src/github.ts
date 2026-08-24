import { CONFIG } from "./config.js";
import { githubPat } from "./secrets.js";

async function gh(slug: string, path: string, init?: RequestInit & { accept?: string }): Promise<Response> {
  const pat = await githubPat();
  const resp = await fetch(`https://api.github.com/repos/${slug}${path}`, {
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

export async function fetchPrDiff(slug: string, prNumber: string): Promise<string> {
  const resp = await gh(slug, `/pulls/${prNumber}`, { accept: "application/vnd.github.diff" });
  return resp.text();
}

export async function commentOnPr(slug: string, prNumber: string, body: string): Promise<void> {
  await gh(slug, `/issues/${prNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

/** Changed file paths of a PR (eval scoring). */
export async function fetchPrFiles(slug: string, prNumber: string): Promise<string[]> {
  const resp = await gh(slug, `/pulls/${prNumber}/files?per_page=100`);
  const files = (await resp.json()) as { filename: string }[];
  return files.map((f) => f.filename);
}

/** Close a PR and delete its branch (eval cleanup). */
export async function closePrAndBranch(slug: string, prNumber: string, branch: string): Promise<void> {
  await gh(slug, `/pulls/${prNumber}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
  await gh(slug, `/git/refs/heads/${branch}`, { method: "DELETE" }).catch(() => {});
}

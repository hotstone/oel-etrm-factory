import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { githubPat } from "./secrets.js";

const execFileAsync = promisify(execFile);

/**
 * Remove anything that looks like a GitHub token from text bound for a log or a
 * Linear comment. Failure paths are the leak-prone ones: child-process errors
 * quote the command that failed, so any credential in argv or a URL ends up in
 * CloudWatch verbatim.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "***")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "***")
    .replace(/(https?:\/\/)[^@\s/]+:[^@\s/]+@/g, "$1***@");
}

/**
 * Shallow-clone the target repo into a temp dir; returns its path.
 *
 * The PAT is passed through a credential helper reading the environment, never
 * through argv or the remote URL: argv is world-readable via `ps` inside the
 * microVM, and it survives into child-process error messages.
 */
export async function cloneWorkspace(slug: string): Promise<string> {
  const pat = await githubPat();
  const dir = await mkdtemp(join(tmpdir(), "etrm-workspace-"));
  const helper = `!f() { echo username=x-access-token; echo "password=$ETRM_GH_PAT"; }; f`;
  try {
    await execFileAsync(
      "git",
      ["-c", `credential.helper=${helper}`, "clone", "--depth", "1", `https://github.com/${slug}.git`, dir],
      { timeout: 120_000, env: { ...process.env, ETRM_GH_PAT: pat } },
    );
  } catch (err) {
    // Re-throw without the credential helper text or any token the child echoed.
    throw new Error(
      `git clone ${slug} failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
    );
  }
  return dir;
}

export async function removeWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

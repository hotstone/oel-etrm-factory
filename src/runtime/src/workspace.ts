import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG } from "./config.js";
import { githubPat } from "./secrets.js";

const execFileAsync = promisify(execFile);

/** Shallow-clone the target repo into a temp dir; returns its path. */
export async function cloneWorkspace(): Promise<string> {
  const pat = await githubPat();
  const dir = await mkdtemp(join(tmpdir(), "etrm-workspace-"));
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", `https://x-access-token:${pat}@github.com/${CONFIG.repo}.git`, dir],
    { timeout: 120_000 },
  );
  // Scrub the credential from the remote so Claude Code sessions running in
  // this workspace hold no push (or even fetch) credential.
  await execFileAsync(
    "git",
    ["remote", "set-url", "origin", `https://github.com/${CONFIG.repo}.git`],
    { cwd: dir },
  );
  return dir;
}

export async function removeWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

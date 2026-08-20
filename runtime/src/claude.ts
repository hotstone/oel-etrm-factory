import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ClaudeResult {
  text: string;
  sessionId: string;
}

/**
 * Run a headless Claude Code session in `cwd`, read-only (plan mode).
 * Pass `resumeSessionId` to continue a previous session with its context intact.
 * Authenticates to Bedrock with the process's IAM credentials.
 */
export async function runClaudePlanning(
  cwd: string,
  prompt: string,
  resumeSessionId?: string,
): Promise<ClaudeResult> {
  const args = ["-p", prompt, "--permission-mode", "plan", "--output-format", "json"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);

  const { stdout } = await execFileAsync("claude", args, {
    cwd,
    timeout: CONFIG.limits.claudeTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: CONFIG.region,
      ANTHROPIC_MODEL: CONFIG.models.claudeCode,
      ANTHROPIC_SMALL_FAST_MODEL: CONFIG.models.claudeCodeSmallFast,
      // The runtime container is an ephemeral sandbox; permits running as root.
      IS_SANDBOX: "1",
    },
  });

  const parsed = JSON.parse(stdout) as { result?: string; session_id?: string; is_error?: boolean };
  if (parsed.is_error || typeof parsed.result !== "string" || !parsed.session_id) {
    throw new Error(`claude session failed: ${stdout.slice(0, 500)}`);
  }
  return { text: parsed.result, sessionId: parsed.session_id };
}

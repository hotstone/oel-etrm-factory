import { spawn } from "node:child_process";
import { CONFIG } from "./config.js";

export interface ClaudeResult {
  text: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Run a headless Claude Code session in `cwd`, read-only (plan mode).
 * The prompt is piped over stdin so arbitrarily large prompts (plans, diffs)
 * never hit argv limits or get echoed into error messages.
 * Pass `resumeSessionId` to continue a previous session with its context intact.
 * Authenticates to Bedrock with the process's IAM credentials.
 */
export async function runClaudePlanning(
  cwd: string,
  prompt: string,
  resumeSessionId?: string,
): Promise<ClaudeResult> {
  const args = ["-p", "--permission-mode", "plan", "--output-format", "json"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);

  const { stdout, stderr, code } = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      timeout: CONFIG.limits.claudeTimeoutMs,
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
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (c) => resolve({ stdout: out, stderr: err, code: c }));
    child.stdin.write(prompt);
    child.stdin.end();
  });

  if (code !== 0) {
    throw new Error(
      `claude exited with code ${code}: ${(stderr || stdout).slice(-800).trim() || "(no output)"}`,
    );
  }
  const parsed = JSON.parse(stdout) as {
    result?: string;
    session_id?: string;
    is_error?: boolean;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (parsed.is_error || typeof parsed.result !== "string" || !parsed.session_id) {
    throw new Error(`claude session failed: ${stdout.slice(0, 500)}`);
  }
  return {
    text: parsed.result,
    sessionId: parsed.session_id,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
  };
}

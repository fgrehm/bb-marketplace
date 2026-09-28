import { runProcess, type ProcessRunner } from "./pi-process.ts";
import { createTextSessionPath, piBridgeSessionDir, type TextTask } from "./pi-session.ts";
import { isCommitPrompt, textServiceArgs } from "./pi-title.ts";

/** BB allows five seconds for both text tasks; leave a margin for a busy host. */
const TEXT_TIMEOUT_MS = 4_000;
/** BB bounds a fresh readiness answer at about two seconds. */
const READINESS_TIMEOUT_MS = 1_800;
/**
 * Text mode emits one line, but a runaway or misbehaving process should still
 * not exhaust memory. A generous cap is a runaway guard, not a budget.
 */
const MAX_TEXT_OUTPUT_BYTES = 256 * 1024;

interface RunnerOptions {
  run?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  sessionDir?: string;
}

export async function generateText({ prompt, model, signal, run = runProcess, env = process.env, sessionDir = piBridgeSessionDir() }: RunnerOptions & {
  prompt: string;
  model: string | null;
  signal?: AbortSignal;
}): Promise<{ text: string }> {
  const task: TextTask = isCommitPrompt(prompt) ? "commit" : "title";
  const sessionPath = await createTextSessionPath(task, sessionDir);
  const result = await run("pi", textServiceArgs({ prompt, model, sessionPath, sessionDir }), {
    env, signal, timeoutMs: TEXT_TIMEOUT_MS, maxStdoutBytes: MAX_TEXT_OUTPUT_BYTES,
  });
  if (result.timedOut) throw new Error("Pi text generation timed out.");
  if (result.error) throw new Error(`Pi text generation failed: ${result.error}`);
  if (result.code !== 0) throw new Error(`Pi text generation failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  // BB cleans the reply for both tasks: it strips quotes, labels and extra
  // lines for a title, and clamps a commit subject to 72 columns. Trimming the
  // trailing newline is all this needs to do.
  const text = result.stdout.trim();
  if (!text) throw new Error("Pi text generation returned no usable answer.");
  return { text };
}

export type TextReadiness = { ready: true } | { ready: false; message: string };

export async function probeTextReadiness({ run = runProcess, env = process.env }: RunnerOptions = {}): Promise<TextReadiness> {
  try {
    const result = await run("pi", ["--list-models"], {
      env, timeoutMs: READINESS_TIMEOUT_MS, maxStdoutBytes: MAX_TEXT_OUTPUT_BYTES,
    });
    if (result.timedOut) return { ready: false, message: "Timed out asking pi for its model list." };
    if (result.error) return { ready: false, message: `Unable to run pi: ${result.error}` };
    const rows = result.stdout.split("\n").filter((line) => line.trim() && !/^provider\s+model\b/i.test(line.trim()));
    if (result.code === 0 && rows.length > 0) return { ready: true };
    return { ready: false, message: result.stderr.trim() || "Pi reported no available models. Sign in with /login or refresh the model catalog." };
  } catch (error) {
    return { ready: false, message: `Unable to run pi: ${error instanceof Error ? error.message : String(error)}` };
  }
}

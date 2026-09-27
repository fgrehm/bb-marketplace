import { runProcess, type ProcessRunner } from "./pi-process.ts";
import { parseTextEnvelope, textServiceArgs } from "./pi-title.ts";

/** BB allows five seconds for both text tasks; leave a margin for a busy host. */
const TEXT_TIMEOUT_MS = 4_000;
/** BB bounds a fresh readiness answer at about two seconds. */
const READINESS_TIMEOUT_MS = 1_800;
const MAX_TEXT_OUTPUT_BYTES = 64 * 1024;

interface RunnerOptions {
  run?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
}

export async function generateText({ prompt, model, signal, run = runProcess, env = process.env }: RunnerOptions & {
  prompt: string;
  model: string | null;
  signal?: AbortSignal;
}): Promise<{ text: string; model: string | null }> {
  const result = await run("pi", textServiceArgs({ prompt, model }), {
    env, signal, timeoutMs: TEXT_TIMEOUT_MS, maxStdoutBytes: MAX_TEXT_OUTPUT_BYTES,
  });
  if (result.timedOut) throw new Error("Pi text generation timed out.");
  if (result.error) throw new Error(`Pi text generation failed: ${result.error}`);
  if (result.code !== 0) throw new Error(`Pi text generation failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  const answer = parseTextEnvelope(result.stdout);
  if (!answer) throw new Error("Pi text generation returned no usable answer.");
  return { text: answer.text, model: answer.model };
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

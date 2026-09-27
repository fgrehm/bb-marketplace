import { runProcess, type ProcessRunner } from "./pi-process.ts";
import { parseTitleEnvelope, titleServiceArgs } from "./pi-title.ts";

const TITLE_TIMEOUT_MS = 4_000; // BB's outer title task has a five-second budget.
const READINESS_TIMEOUT_MS = 1_800; // BB bounds a fresh status at about two seconds.
const MAX_TITLE_OUTPUT_BYTES = 64 * 1024;

interface RunnerOptions {
  run?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
}

export async function generateTitle({ prompt, model, signal, run = runProcess, env = process.env }: RunnerOptions & {
  prompt: string;
  model: string | null;
  signal?: AbortSignal;
}): Promise<{ title: string; model: string | null }> {
  const result = await run("pi", titleServiceArgs({ prompt, model }), {
    env, signal, timeoutMs: TITLE_TIMEOUT_MS, maxStdoutBytes: MAX_TITLE_OUTPUT_BYTES,
  });
  if (result.timedOut) throw new Error("Pi title generation timed out.");
  if (result.error) throw new Error(`Pi title generation failed: ${result.error}`);
  if (result.code !== 0) throw new Error(`Pi title generation failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  const answer = parseTitleEnvelope(result.stdout);
  if (!answer) throw new Error("Pi title generation returned no usable answer.");
  return { title: answer.text, model: answer.model };
}

export type TitleReadiness = { ready: true } | { ready: false; message: string };

export async function probeTitleReadiness({ run = runProcess, env = process.env }: RunnerOptions = {}): Promise<TitleReadiness> {
  try {
    const result = await run("pi", ["--list-models"], {
      env, timeoutMs: READINESS_TIMEOUT_MS, maxStdoutBytes: MAX_TITLE_OUTPUT_BYTES,
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

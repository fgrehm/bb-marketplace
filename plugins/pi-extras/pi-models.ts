import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { PiModelList, PiModelSummary } from "./model-scope.js";

function compareModels(left: PiModelSummary, right: PiModelSummary): number {
  const byProvider = left.provider.localeCompare(right.provider);
  return byProvider === 0 ? left.id.localeCompare(right.id) : byProvider;
}

const RPC_REQUEST_ID = "bb-pi-extras-models";
const RPC_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toSummary(raw: unknown): PiModelSummary | null {
  if (!isRecord(raw)) return null;
  const provider = asString(raw.provider);
  const id = asString(raw.id);
  if (!provider || !id) return null;
  return {
    provider,
    id,
    name: asString(raw.name),
    contextWindow: asNumber(raw.contextWindow),
    maxTokens: asNumber(raw.maxTokens),
    reasoning: raw.reasoning === true,
    images: Array.isArray(raw.input) && raw.input.includes("image"),
  };
}

/**
 * Extracts the models from a `get_available_models` RPC response. Pi interleaves
 * other records (extension UI requests, session events) on stdout, so the
 * response correlated by id is the only one considered.
 */
export function parseAvailableModels(stdout: string): PiModelSummary[] {
  const models: PiModelSummary[] = [];
  let failure: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.type !== "response" || record.id !== RPC_REQUEST_ID) continue;
    if (record.command !== "get_available_models") continue;
    if (record.success !== true) {
      failure = asString(record.error) ?? "Pi did not return a model list.";
      continue;
    }
    const data = isRecord(record.data) ? record.data : null;
    const rawModels = data && Array.isArray(data.models) ? data.models : [];
    for (const raw of rawModels) {
      const summary = toSummary(raw);
      if (summary !== null) models.push(summary);
    }
  }
  if (failure !== null) throw new Error(failure);
  return models.sort(compareModels);
}

export async function listAvailableModels(env: NodeJS.ProcessEnv = process.env): Promise<PiModelList> {
  return new Promise<PiModelList>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("pi", ["--mode", "rpc", "--no-session"], { env, stdio: "pipe" });
    } catch (error) {
      resolve({ models: [], error: `Unable to run pi: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (list: PiModelList) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(list);
    };
    const timer = setTimeout(
      () => finish({ models: [], error: "Timed out reading the Pi model list." }),
      RPC_TIMEOUT_MS,
    );

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length <= MAX_STDOUT_BYTES) return;
      child.kill();
      finish({ models: [], error: "The Pi model list was too large to read." });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });

    child.on("error", (error) => finish({ models: [], error: `Unable to run pi: ${error.message}` }));
    child.on("close", (code) => {
      let models: PiModelSummary[];
      try {
        models = parseAvailableModels(stdout);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const detail = stderr.trim();
        finish({ models: [], error: detail ? `${reason} ${detail}` : reason });
        return;
      }
      if (models.length === 0) {
        const detail = stderr.trim();
        finish({
          models: [],
          error: code === 0
            ? detail || "Pi reported no available models. Sign in with /login or refresh the model catalog."
            : `pi exited with code ${code ?? "unknown"}. ${detail}`.trim(),
        });
        return;
      }
      finish({ models, error: null });
    });

    child.stdin.on("error", () => {
      /* Pi may exit before reading the command; the close handler reports why. */
    });
    child.stdin.end(`${JSON.stringify({ id: RPC_REQUEST_ID, type: "get_available_models" })}\n`);
  });
}

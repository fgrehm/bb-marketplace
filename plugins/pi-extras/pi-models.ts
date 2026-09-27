import type { PiModelList, PiModelSummary } from "./model-scope.js";
import { runProcess } from "./pi-process.ts";

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
  const result = await runProcess("pi", ["--mode", "rpc", "--no-session"], {
    env,
    input: `${JSON.stringify({ id: RPC_REQUEST_ID, type: "get_available_models" })}\n`,
    timeoutMs: RPC_TIMEOUT_MS,
    maxStdoutBytes: MAX_STDOUT_BYTES,
  });
  if (result.timedOut) return { models: [], error: "Timed out reading the Pi model list." };
  if (result.error) return { models: [], error: result.error };
  let models: PiModelSummary[];
  try {
    models = parseAvailableModels(result.stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const detail = result.stderr.trim();
    return { models: [], error: detail ? `${reason} ${detail}` : reason };
  }
  if (models.length === 0) {
    const detail = result.stderr.trim();
    return {
      models: [],
      error: result.code === 0
        ? detail || "Pi reported no available models. Sign in with /login or refresh the model catalog."
        : `pi exited with code ${result.code ?? "unknown"}. ${detail}`.trim(),
    };
  }
  return { models, error: null };
}

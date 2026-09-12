import { isIgnoredUsageModel } from "./pricing";
import type { UsageProviderKind, UsageRecord, UsageTokenTotals } from "./types";
import { totalTokens } from "./types";

function int(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function nonNegativeCost(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Maps the backend recorded by Pi on a usage event to a usage provider. */
function sessionProvider(value: unknown): UsageProviderKind {
  if (value === "openai-codex") return "codex";
  if (value === "opencode-go" || value === "ollama-cloud") return value;
  return "pi";
}

export function mightCarryUsage(
  line: string,
  provider: UsageProviderKind,
): boolean {
  return (
    line.includes('"usage"') ||
    line.includes('"cost"') ||
    line.includes('"token_count"') ||
    line.includes('"turn_context"') ||
    line.includes('"session_meta"')
  );
}

export function parsePiLine(
  line: string,
  sessionIdFallback: string,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const message =
    record.type === "message" && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : record;

  if (message.role !== "assistant") return null;
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs =
    parseTimestampMs(record.timestamp) ??
    parseTimestampMs(record.createdAt) ??
    parseTimestampMs(message.timestamp);
  if (timestampMs === null) return null;

  const model =
    typeof message.model === "string"
      ? message.model
      : typeof record.model === "string"
        ? record.model
        : "";
  if (model.length === 0) return null;

  const input = int(usageRecord.input ?? usageRecord.input_tokens);
  const output = int(usageRecord.output ?? usageRecord.output_tokens);
  const cacheRead = int(
    usageRecord.cacheRead ?? usageRecord.cache_read_input_tokens,
  );
  const cacheWrite = int(
    usageRecord.cacheWrite ?? usageRecord.cache_creation_input_tokens,
  );
  const reasoning = int(
    usageRecord.reasoning ?? usageRecord.reasoning_output_tokens,
  );

  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(0, input),
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: Math.min(output, reasoning),
  };
  if (totalTokens(totals) === 0) return null;

  let reportedCostUsd: number | null = null;
  const cost = usageRecord.cost;
  const directCost = nonNegativeCost(cost);
  if (directCost !== null) {
    reportedCostUsd = directCost;
  } else if (typeof cost === "object" && cost !== null) {
    reportedCostUsd = nonNegativeCost(
      (cost as Record<string, unknown>).total,
    );
  }

  const id =
    typeof record.id === "string"
      ? record.id
      : typeof message.id === "string"
        ? message.id
        : null;

  return {
    provider: sessionProvider(message.provider ?? record.provider),
    timestampMs,
    model,
    sessionId:
      typeof record.sessionId === "string"
        ? record.sessionId
        : sessionIdFallback,
    projectPath: "",
    totals,
    reportedCostUsd,
    dedupeKey: id,
  };
}

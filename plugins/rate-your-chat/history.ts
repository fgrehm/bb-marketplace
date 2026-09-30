import { z } from "zod";
import type { History, Observation } from "./model";

// Filter server-side. Never read chat output, tool deltas, or complete timelines.
export const HISTORY_TYPES = [
  "client/turn/requested",
  "client/turn/rejected",
  "client/thread/start",
  "client/turn/start",
  "provider/modelFallback",
] as const;
export interface HistoryRow {
  seq: number;
  createdAt: number;
  type: string;
  data: unknown;
}
type ReadPage = (args: {
  order: "asc" | "desc";
  limit: string;
  afterSeq?: string;
  beforeSeq?: string;
}) => Promise<HistoryRow[]>;
const metadata = z.object({
  requestId: z.string().optional(),
  execution: z
    .object({
      model: z.string().optional(),
      reasoningLevel: z.string().optional(),
    })
    .optional(),
  request: z
    .object({
      params: z.object({
        model: z.string().optional(),
        reasoningLevel: z.string().optional(),
      }),
    })
    .optional(),
  originalModel: z.string().optional(),
  fallbackModel: z.string().optional(),
});

export async function captureHistory(
  read: ReadPage,
  options: { maxPages?: number } = {},
): Promise<History> {
  const latest = await read({ order: "desc", limit: "1" });
  const throughSeq = latest[0]?.seq ?? 0;
  const history: History = {
    capturedAt: Date.now(),
    throughSeq,
    status: "recorded",
    warnings: [],
    observations: [],
  };
  const warnings = new Set<string>();
  const rejected = new Set<string>();
  let after = 0;
  let precedingRequest: {
    model: string | null;
    reasoningLevel: string | null;
  } | null = null;
  // At most 10,000 relevant events. RPC handlers additionally have a 30s deadline.
  const maxPages = options.maxPages ?? 100;
  for (let page = 0; throughSeq > 0 && page < maxPages; page++) {
    const rows = await read({
      order: "asc",
      limit: "100",
      afterSeq: String(after),
      beforeSeq: String(throughSeq + 1),
    });
    if (rows.length === 0)
      throw new Error(
        "Recorded history changed during capture. Retry saving the rating.",
      );
    for (const row of rows) {
      if (row.seq <= after || row.seq > throughSeq)
        throw new Error(
          "History cursor did not advance within the capture boundary.",
        );
      after = row.seq;
      const parsed = metadata.safeParse(row.data);
      if (!parsed.success) {
        warnings.add("Some execution metadata could not be decoded.");
        history.status = "partial";
        continue;
      }
      const data = parsed.data;
      if (row.type === "client/turn/rejected") {
        if (data.requestId) rejected.add(data.requestId);
        continue;
      }
      const evidence =
        row.type === "provider/modelFallback"
          ? "provider-fallback"
          : row.type === "client/turn/requested"
            ? "requested"
            : "legacy-request";
      const values =
        evidence === "requested" ? data.execution : data.request?.params;
      const model =
        evidence === "provider-fallback"
          ? (data.fallbackModel ?? null)
          : (values?.model ?? null);
      const reasoningLevel =
        evidence === "provider-fallback"
          ? null
          : (values?.reasoningLevel ?? null);
      // Modern requests can have a companion lifecycle row. Ignore duplicates, but keep differing settings.
      if (evidence === "legacy-request" && precedingRequest) {
        const duplicate =
          (model === null || model === precedingRequest.model) &&
          (reasoningLevel === null ||
            reasoningLevel === precedingRequest.reasoningLevel);
        precedingRequest = null;
        if (duplicate) continue;
      }
      if (evidence === "requested")
        precedingRequest = { model, reasoningLevel };
      if (evidence === "legacy-request") {
        warnings.add(
          "Legacy lifecycle metadata may duplicate requests or omit execution settings.",
        );
        history.status = "partial";
      }
      if (evidence === "provider-fallback")
        warnings.add("Provider fallbacks do not report their reasoning level.");
      if (
        model === null ||
        (reasoningLevel === null && evidence !== "provider-fallback")
      ) {
        warnings.add("Some recorded model or reasoning settings are unknown.");
        history.status = "partial";
      }
      history.observations.push({
        seq: row.seq,
        at: row.createdAt,
        model,
        reasoningLevel,
        evidence,
        requestId: data.requestId ?? null,
        originalModel: data.originalModel ?? null,
        rejected: false,
      });
    }
    if (after >= throughSeq) break;
    if (page === maxPages - 1) {
      warnings.add(
        "History exceeded the capture limit; later variations may be missing.",
      );
      history.status = "partial";
    }
  }
  for (const observation of history.observations)
    observation.rejected =
      observation.requestId !== null && rejected.has(observation.requestId);
  if (history.observations.length === 0) {
    warnings.add("No execution history is recorded for this chat.");
    history.status = "partial";
  }
  history.warnings = [...warnings];
  return history;
}

export function summarizeVariations(observations: Observation[]) {
  const variations = new Map<
    string,
    {
      model: string | null;
      reasoningLevel: string | null;
      evidence: Observation["evidence"];
      count: number;
    }
  >();
  for (const observation of observations) {
    if (observation.rejected) continue;
    const key = JSON.stringify([
      observation.model,
      observation.reasoningLevel,
      observation.evidence,
    ]);
    const current = variations.get(key);
    if (current) current.count++;
    else
      variations.set(key, {
        model: observation.model,
        reasoningLevel: observation.reasoningLevel,
        evidence: observation.evidence,
        count: 1,
      });
  }
  return [...variations.values()];
}

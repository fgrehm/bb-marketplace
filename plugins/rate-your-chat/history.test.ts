import { describe, expect, it } from "vitest";
import {
  captureHistory,
  summarizeVariations,
  type HistoryRow,
} from "./history";

function requested(
  seq: number,
  model: string,
  reasoningLevel: string,
): HistoryRow {
  return {
    seq,
    createdAt: seq * 1000,
    type: "client/turn/requested",
    data: {
      requestId: `req_${seq}`,
      execution: { model, reasoningLevel },
      input: [{ text: "private prompt" }],
      request: { params: { secret: "do not copy" } },
    },
  };
}
function reader(rows: HistoryRow[]) {
  return async (args: {
    order?: string;
    afterSeq?: string;
    beforeSeq?: string;
    limit?: string;
  }) => {
    const filtered = rows.filter(
      (r) =>
        r.seq > Number(args.afterSeq ?? 0) &&
        r.seq < Number(args.beforeSeq ?? Infinity),
    );
    return (
      args.order === "desc" ? filtered.slice().reverse() : filtered
    ).slice(0, Number(args.limit));
  };
}

describe("local execution history", () => {
  it("pages sparse event sequences and captures all model/reasoning combinations, including returns to an earlier model", async () => {
    const rows = Array.from({ length: 205 }, (_, i) =>
      requested(
        i * 20 + 1,
        i % 2 ? "model-b" : "model-a",
        i % 3 ? "high" : "low",
      ),
    );
    const result = await captureHistory(reader(rows));
    expect(result.observations).toHaveLength(205);
    expect(result.throughSeq).toBe(4081);
    expect(result.status).toBe("recorded");
    expect(summarizeVariations(result.observations)).toHaveLength(4);
    expect(JSON.stringify(result)).not.toMatch(
      /private prompt|secret|input|params/,
    );
  });
  it("excludes rejected dispatches from variation counts but preserves rejection evidence", async () => {
    const rows = [
      requested(1, "a", "high"),
      requested(2, "b", "low"),
      {
        seq: 3,
        createdAt: 3000,
        type: "client/turn/rejected",
        data: { requestId: "req_2", message: "private" },
      },
    ];
    const result = await captureHistory(reader(rows));
    expect(result.observations[1]?.rejected).toBe(true);
    expect(
      summarizeVariations(result.observations).map((v) => v.model),
    ).toEqual(["a"]);
  });
  it("does not double count companion lifecycle metadata", async () => {
    const result = await captureHistory(
      reader([
        requested(1, "a", "high"),
        {
          seq: 2,
          createdAt: 2000,
          type: "client/thread/start",
          data: { request: { params: { model: "a" } } },
        },
      ]),
    );
    expect(result.observations).toHaveLength(1);
    expect(result.status).toBe("recorded");
  });
  it("captures fallback models without inventing their reasoning level", async () => {
    const result = await captureHistory(
      reader([
        requested(1, "a", "high"),
        {
          seq: 2,
          createdAt: 2000,
          type: "provider/modelFallback",
          data: { originalModel: "a", fallbackModel: "b", message: "private" },
        },
      ]),
    );
    expect(result.observations[1]).toMatchObject({
      model: "b",
      reasoningLevel: null,
      originalModel: "a",
      evidence: "provider-fallback",
    });
    expect(result.warnings).toContain(
      "Provider fallbacks do not report their reasoning level.",
    );
  });
  it("labels legacy metadata and missing fields instead of substituting today's defaults", async () => {
    const result = await captureHistory(
      reader([
        {
          seq: 1,
          createdAt: 1000,
          type: "client/thread/start",
          data: { request: { params: { model: "legacy" } } },
        },
      ]),
    );
    expect(result.observations[0]).toMatchObject({
      model: "legacy",
      reasoningLevel: null,
      evidence: "legacy-request",
    });
    expect(result.status).toBe("partial");
  });
  it("bounds work and reports partial history explicitly", async () => {
    const result = await captureHistory(
      reader(
        Array.from({ length: 201 }, (_, i) => requested(i + 1, "a", "high")),
      ),
      { maxPages: 1 },
    );
    expect(result.observations).toHaveLength(100);
    expect(result.status).toBe("partial");
    expect(result.warnings.join(" ")).toContain("capture limit");
  });
  it("does not include events appended during pagination", async () => {
    const rows = [requested(1, "a", "high")];
    const read = reader(rows);
    let calls = 0;
    const result = await captureHistory(async (args) => {
      const page = await read(args);
      if (++calls === 1) rows.push(requested(2, "b", "low"));
      return page;
    });
    expect(result.observations).toHaveLength(1);
    expect(result.throughSeq).toBe(1);
  });
  it("propagates read failures, so an existing snapshot cannot be silently replaced", async () => {
    await expect(
      captureHistory(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });
  it("refuses a capture when recorded events disappear mid-read", async () => {
    let calls = 0;
    await expect(
      captureHistory(async () => {
        calls++;
        if (calls === 1) return [requested(200, "b", "low")];
        if (calls === 2) return [requested(1, "a", "high")];
        return [];
      }),
    ).rejects.toThrow(/history changed during capture/i);
  });
  it("handles no history without inventing a configuration", async () => {
    const result = await captureHistory(reader([]));
    expect(result.observations).toEqual([]);
    expect(result.status).toBe("partial");
  });
});

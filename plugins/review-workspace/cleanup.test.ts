import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const CURSOR = "review-cleanup-cursor";
type Host = ReturnType<typeof createFakePluginHost>;
const tables = [
  "review_revisions",
  "review_files",
  "review_annotations",
  "review_resolution_suggestions",
  "review_viewed_files",
  "review_review_summaries",
  "review_file_notes",
];

function seed(bb: Host["bb"], threadId: string, createdAt = NOW) {
  const db = bb.storage.database();
  const id = randomUUID(),
    rootId = randomUUID(),
    replyId = randomUUID();
  db.prepare(
    "INSERT INTO review_revisions (id, thread_id, snapshot, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, threadId, `snapshot-${id}`, createdAt);
  db.prepare(
    "INSERT INTO review_files (review_id, path, status, additions, deletions, binary, patch, truncated, old_content, new_content) VALUES (?, 'example.ts', 'M', 1, 1, 0, 'patch', 0, 'old text', 'new text')",
  ).run(id);
  const annotation = db.prepare(
    "INSERT INTO review_annotations (id, review_id, file_path, side, start_line, end_line, body, created_at, parent_id, file_level) VALUES (?, ?, 'example.ts', 'new', 0, 0, 'Unsent feedback', ?, ?, 1)",
  );
  annotation.run(rootId, id, NOW, null);
  annotation.run(replyId, id, NOW, rootId);
  db.prepare(
    "INSERT INTO review_resolution_suggestions (id, annotation_id, rationale, created_at, status) VALUES (?, ?, 'fixed', ?, 'pending')",
  ).run(randomUUID(), rootId, NOW);
  db.prepare(
    "INSERT INTO review_viewed_files (review_id, path, viewed_at) VALUES (?, 'example.ts', ?)",
  ).run(id, NOW);
  db.prepare(
    "INSERT INTO review_review_summaries (review_id, summary, updated_at) VALUES (?, 'Review note', ?)",
  ).run(id, NOW);
  db.prepare(
    "INSERT INTO review_file_notes (review_id, path, summary, updated_at) VALUES (?, 'example.ts', 'File note', ?)",
  ).run(id, NOW);
  return { id, rootId, replyId };
}

function counts(bb: Host["bb"]) {
  const db = bb.storage.database();
  return tables.map(
    (table) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
        .n,
  );
}

function host() {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  return createFakePluginHost({
    pluginId: "review-workspace",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId }),
      },
    },
  });
}

async function sweep(harness: Host["harness"]) {
  await harness.behavior.runSchedule("cleanup");
}

afterEach(() => vi.restoreAllMocks());

describe("Automatic review cleanup", () => {
  it("purges every revision and dependent row after seven archived days, not seven days since the snapshot", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    seed(bb, "expired", NOW); // A new snapshot does not extend an old archive.
    seed(bb, "expired", NOW - 20 * DAY);
    const active = seed(bb, "active", NOW - 100 * DAY);
    harness.sdk.stub(
      "threads.get",
      async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({
          id: threadId,
          archivedAt: threadId === "expired" ? NOW - 7 * DAY : null,
          projectId: threadId === "expired" ? "project-old" : "project-active",
        }),
    );
    await sweep(harness);
    expect(counts(bb)).toEqual([1, 1, 2, 1, 1, 1, 1]);
    expect(
      bb.storage.database().prepare("PRAGMA foreign_key_check").all(),
    ).toEqual([]);
    expect(
      await harness.behavior.callRpc("review", { threadId: "expired" }),
    ).toEqual({ review: null });
    expect(
      await harness.behavior.callRpc("review", { threadId: "active" }),
    ).toMatchObject({ review: { id: active.id } });
    expect(harness.inspection.sdk.callsTo("threads.list")).toHaveLength(0);
    expect(
      harness.inspection.sdk.callsTo("environments.diffFiles"),
    ).toHaveLength(0);
  });

  it("retains just-under-seven-day archives and restores, and restarts grace on rearchive", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const recent = seed(bb, "recent"),
      restored = seed(bb, "restored"),
      rearchived = seed(bb, "rearchived");
    harness.sdk.stub(
      "threads.get",
      async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({
          id: threadId,
          archivedAt:
            threadId === "recent"
              ? NOW - 7 * DAY + 1
              : threadId === "rearchived"
                ? NOW - DAY
                : null,
        }),
    );
    await harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "restored", archivedAt: NOW - 8 * DAY }),
    });
    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "restored", archivedAt: null }),
    });
    await sweep(harness);
    for (const [threadId, review] of [
      ["recent", recent],
      ["restored", restored],
      ["rearchived", rearchived],
    ] as const) {
      expect(
        await harness.behavior.callRpc("review", { threadId }),
      ).toMatchObject({ review: { id: review.id } });
    }
  });

  it("cleans immediately on thread deletion without touching child or same-checkout reviews", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    seed(bb, "parent");
    seed(bb, "parent");
    const child = seed(bb, "child"),
      other = seed(bb, "other");
    const result = await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "parent", deletedAt: NOW }),
    });
    expect(result.errors).toEqual([]);
    expect(counts(bb)).toEqual([2, 2, 4, 2, 2, 2, 2]);
    for (const [threadId, review] of [
      ["child", child],
      ["other", other],
    ] as const) {
      expect(
        await harness.behavior.callRpc("review", { threadId }),
      ).toMatchObject({ review: { id: review.id } });
    }
    expect(harness.inspection.sdk.calls).toHaveLength(0);
    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "parent", deletedAt: NOW }),
    });
    expect(counts(bb)).toEqual([2, 2, 4, 2, 2, 2, 2]);
  });

  it("preserves independently imported comment roots and replies when the source is purged", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const source = seed(bb, "source"),
      target = seed(bb, "target");
    await harness.behavior.callAgentTool(
      "review_workspace_import",
      { reviewId: source.id },
      { threadId: "target" },
    );
    const before = await harness.behavior.callRpc("review", {
      threadId: "target",
    });
    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "source", deletedAt: NOW }),
    });
    expect(
      await harness.behavior.callRpc("review", { threadId: "target" }),
    ).toEqual(before);
    const loaded = before as {
      review: {
        annotations: Array<{
          id: string;
          parentId: string | null;
          carriedFromAnnotationId: string | null;
        }>;
      };
    };
    const importedRoot = loaded.review.annotations.find(
      (a) => a.carriedFromAnnotationId === source.rootId,
    )!;
    const importedReply = loaded.review.annotations.find(
      (a) => a.carriedFromAnnotationId === source.replyId,
    )!;
    expect(importedReply.parentId).toBe(importedRoot.id);
    expect(counts(bb)).toEqual([1, 1, 4, 1, 1, 1, 1]);
    expect(target.id).not.toBe(source.id);
  });

  it("catches pre-existing archived, hidden, deleted and missing owners on startup", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    for (const threadId of ["archived", "hidden", "deleted", "missing"])
      seed(bb, threadId);
    harness.sdk.stub(
      "threads.get",
      async ({ threadId }: { threadId: string }) => {
        if (threadId === "missing")
          throw Object.assign(new Error("Thread not found"), {
            status: 404,
            code: "thread_not_found",
          });
        return makeThreadResponse({
          id: threadId,
          visibility: threadId === "hidden" ? "hidden" : "visible",
          archivedAt: NOW - 8 * DAY,
          deletedAt: threadId === "deleted" ? NOW : null,
        });
      },
    );
    await harness.behavior.runService("cleanup-startup").done;
    expect(counts(bb)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("retains data on unavailable or non-thread-not-found responses while continuing the sweep", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    for (const threadId of ["a-unavailable", "b-wrong-route", "c-expired"])
      seed(bb, threadId);
    harness.sdk.stub(
      "threads.get",
      async ({ threadId }: { threadId: string }) => {
        if (threadId === "a-unavailable")
          throw Object.assign(new Error("Unavailable"), {
            status: 503,
            code: "unavailable",
          });
        if (threadId === "b-wrong-route")
          throw Object.assign(new Error("Wrong route"), {
            status: 404,
            code: "route_not_found",
          });
        return makeThreadResponse({ id: threadId, archivedAt: NOW - 8 * DAY });
      },
    );
    await sweep(harness);
    expect(counts(bb)).toEqual([2, 2, 4, 2, 2, 2, 2]);
    expect(
      harness.inspection.logEntries.some((entry) => entry.level === "warn"),
    ).toBe(true);
    harness.sdk.stub(
      "threads.get",
      async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({ id: threadId, archivedAt: NOW - 8 * DAY }),
    );
    await sweep(harness);
    expect(counts(bb)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("bounds each pass to 100 owners and continues across reloads without starving later owners", async () => {
    let { bb, harness } = host();
    await plugin(bb);
    for (let i = 0; i < 105; i++)
      seed(bb, `thread-${String(i).padStart(3, "0")}`);
    await sweep(harness);
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(100);
    expect(await bb.storage.kv.get(CURSOR)).toBe("thread-099");
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    harness.sdk.stub(
      "threads.get",
      async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({
          id: threadId,
          archivedAt: threadId === "thread-104" ? NOW - 8 * DAY : null,
        }),
    );
    await harness.behavior.runService("cleanup-startup").done;
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(5);
    expect(
      await harness.behavior.callRpc("review", { threadId: "thread-104" }),
    ).toEqual({ review: null });
    expect(await bb.storage.kv.get(CURSOR)).toBe("");
    await sweep(harness);
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(105);
    await harness.lifecycle.dispose();
  });

  it.each(["thread.unarchived", "thread.archived"] as const)(
    "coalesces sweeps and retains stale lookup data after $0",
    async (event) => {
      const { bb, harness } = host();
      await plugin(bb);
      const saved = seed(bb, "restore-race");
      let finish!: (value: ReturnType<typeof makeThreadResponse>) => void;
      harness.sdk.stub(
        "threads.get",
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const startup = harness.behavior.runService("cleanup-startup");
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const periodic = sweep(harness);
      await harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({
          id: "restore-race",
          archivedAt: event === "thread.archived" ? NOW : null,
        }),
      });
      finish(
        makeThreadResponse({ id: "restore-race", archivedAt: NOW - 8 * DAY }),
      );
      await startup.done;
      await periodic;
      expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
      expect(
        await harness.behavior.callRpc("review", { threadId: "restore-race" }),
      ).toMatchObject({ review: { id: saved.id } });
    },
  );

  it("retains timed-out lookup data, saves partial progress, and resumes on the next pass", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    for (const threadId of ["a", "b", "c"]) seed(bb, threadId);
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) =>
        ms === 60_000 ? deadline.signal : new AbortController().signal,
      );
    let finish!: (value: ReturnType<typeof makeThreadResponse>) => void;
    harness.sdk.stub("threads.get", ({ threadId }: { threadId: string }) =>
      threadId === "a"
        ? Promise.resolve(makeThreadResponse({ id: "a" }))
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const startup = harness.behavior.runService("cleanup-startup");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    deadline.abort();
    finish(makeThreadResponse({ id: "b", archivedAt: NOW - 8 * DAY }));
    await startup.done;
    expect(counts(bb)).toEqual([3, 3, 6, 3, 3, 3, 3]);
    expect(await bb.storage.kv.get(CURSOR)).toBe("a");
    timeout.mockRestore();
    harness.sdk.stub(
      "threads.get",
      async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({ id: threadId, archivedAt: NOW - 8 * DAY }),
    );
    await sweep(harness);
    expect(counts(bb)).toEqual([1, 1, 2, 1, 1, 1, 1]);
    expect(
      harness.inspection.sdk
        .callsTo("threads.get")
        .map(([input]) => (input as { threadId: string }).threadId),
    ).toEqual(["a", "b", "b", "c"]);
  });

  it("aborts in-flight lookups on disposal and never purges their stale responses", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    seed(bb, "dispose-race");
    let finish!: (value: ReturnType<typeof makeThreadResponse>) => void;
    let signal!: AbortSignal;
    harness.sdk.stub("threads.get", (args: { signal: AbortSignal }) => {
      signal = args.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const startup = harness.behavior.runService("cleanup-startup");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await harness.lifecycle.dispose();
    expect(signal.aborted).toBe(true);
    finish(
      makeThreadResponse({ id: "dispose-race", archivedAt: NOW - 8 * DAY }),
    );
    await expect(startup.done).resolves.toBeUndefined();
  });

  it("does no SDK work without review owners, and recovers from a stale cursor", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    await sweep(harness);
    expect(harness.inspection.sdk.calls).toHaveLength(0);
    await bb.storage.kv.set(CURSOR, "zzz-no-longer-exists");
    seed(bb, "a-owner");
    await sweep(harness);
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
  });
});

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { captureHistory, HISTORY_TYPES, summarizeVariations } from "./history";
import {
  historySchema,
  normalizeStoredRating,
  promptSchema,
  ratingSchema,
  useCasesSchema,
  type Rating,
} from "./model";

const threadIdSchema = z.string().min(1).max(200);
const feedbackSchema = z.object({
  score: z.number().int().min(1).max(5),
  useCases: useCasesSchema,
  note: z.string().trim().max(4000),
});
const variationSchema = z.object({
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  evidence: z.enum(["requested", "legacy-request", "provider-fallback"]),
  count: z.number(),
});
const summarySchema = ratingSchema.omit({ history: true }).extend({
  history: historySchema.omit({ observations: true }),
  variations: z.array(variationSchema),
  variationCount: z.number(),
});
export type RatingSummary = z.infer<typeof summarySchema>;
export const rpcContract = defineRpcContract({
  pending: {
    input: z.null(),
    output: z.object({ prompt: promptSchema.nullable(), count: z.number() }),
  },
  dismiss: {
    input: z
      .object({ threadId: threadIdSchema, archivedAt: z.number() })
      .strict(),
    output: z.object({ removed: z.boolean() }),
  },
  getRating: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: ratingSchema.nullable(),
  },
  savePrompt: {
    input: feedbackSchema
      .extend({
        threadId: threadIdSchema,
        archivedAt: z.number(),
        expectedRevision: z.number().int().positive().nullable(),
      })
      .strict(),
    output: ratingSchema,
  },
  editRating: {
    input: feedbackSchema
      .extend({
        threadId: threadIdSchema,
        expectedRevision: z.number().int().positive(),
      })
      .strict(),
    output: ratingSchema,
  },
  deleteRating: {
    input: z
      .object({
        threadId: threadIdSchema,
        expectedRevision: z.number().int().positive(),
      })
      .strict(),
    output: z.object({ removed: z.boolean() }),
  },
  list: {
    input: z
      .object({ offset: z.number().int().nonnegative().default(0) })
      .strict(),
    output: z.object({ ratings: z.array(summarySchema), total: z.number() }),
  },
  exportPage: {
    input: z
      .object({ afterThreadId: z.string().max(200).default("") })
      .strict(),
    output: z.object({ rating: ratingSchema.nullable() }),
  },
});

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE ratings (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL)`,
    `CREATE TABLE observations (thread_id TEXT NOT NULL REFERENCES ratings(thread_id) ON DELETE CASCADE, seq INTEGER NOT NULL, at INTEGER NOT NULL, model TEXT, reasoning_level TEXT, evidence TEXT NOT NULL, request_id TEXT, original_model TEXT, rejected INTEGER NOT NULL, PRIMARY KEY (thread_id, seq))`,
    `CREATE INDEX observation_variations ON observations(model, reasoning_level)`,
    `CREATE TABLE prompts (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, archived_at INTEGER NOT NULL)`,
    `CREATE TABLE revision_clock (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`,
    `INSERT INTO revision_clock VALUES (1, COALESCE((SELECT MAX(revision) FROM ratings), 0))`,
  ]);
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  const changed = () => bb.realtime.publish("changed", null);
  const get = (threadId: string): Rating | null => {
    const row = db
      .prepare("SELECT record FROM ratings WHERE thread_id = ?")
      .get(threadId) as { record: string } | undefined;
    return row
      ? ratingSchema.parse(normalizeStoredRating(JSON.parse(row.record)))
      : null;
  };
  const checkRevision = (threadId: string, expected: number | null) => {
    const current = get(threadId);
    if ((current?.revision ?? null) !== expected)
      throw new Error(
        "This rating changed in another window. Reload before saving.",
      );
    return current;
  };
  // Allocate inside the write transaction. Deleting feedback never resets this clock.
  const nextRevision = () => {
    const { value } = db
      .prepare(
        "UPDATE revision_clock SET value = max(value, COALESCE((SELECT MAX(revision) FROM ratings), 0)) + 1 WHERE id = 1 RETURNING value",
      )
      .get() as { value: number };
    if (!Number.isSafeInteger(value))
      throw new Error("Rating revision limit reached.");
    return value;
  };
  const hasPrompt = (threadId: string, archivedAt: number) =>
    !!db
      .prepare("SELECT 1 FROM prompts WHERE thread_id = ? AND archived_at = ?")
      .get(threadId, archivedAt);
  const put = (rating: Rating) => {
    db.prepare(
      "INSERT INTO ratings(thread_id, revision, record) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, record = excluded.record",
    ).run(rating.threadId, rating.revision, JSON.stringify(rating));
    db.prepare("DELETE FROM observations WHERE thread_id = ?").run(
      rating.threadId,
    );
    const insert = db.prepare(
      "INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const o of rating.history.observations)
      insert.run(
        rating.threadId,
        o.seq,
        o.at,
        o.model,
        o.reasoningLevel,
        o.evidence,
        o.requestId,
        o.originalModel,
        Number(o.rejected),
      );
  };
  bb.events.on("thread.archived", ({ thread }) => {
    if (
      thread.visibility === "hidden" ||
      thread.deletedAt !== null ||
      thread.archivedAt === null
    )
      return;
    db.prepare(
      "INSERT INTO prompts VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET title = excluded.title, archived_at = excluded.archived_at",
    ).run(
      thread.id,
      thread.title ?? thread.titleFallback ?? thread.id,
      thread.archivedAt,
    );
    changed();
  });
  for (const event of ["thread.unarchived", "thread.deleted"] as const)
    bb.events.on(event, ({ thread }) => {
      if (
        db.prepare("DELETE FROM prompts WHERE thread_id = ?").run(thread.id)
          .changes
      )
        changed();
    });

  bb.rpc.register(rpcContract, {
    async pending() {
      const rows = db
        .prepare(
          "SELECT thread_id AS threadId, title, archived_at AS archivedAt FROM prompts ORDER BY archived_at, thread_id LIMIT 20",
        )
        .all()
        .map((row) => promptSchema.parse(row));
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(10_000),
      ]);
      let prompt: z.infer<typeof promptSchema> | null = null;
      let removed = 0;
      try {
        for (const row of rows) {
          try {
            const thread = await bb.sdk.threads.get({
              threadId: row.threadId,
              signal,
            });
            if (
              thread.archivedAt === row.archivedAt &&
              thread.deletedAt === null &&
              thread.visibility !== "hidden"
            ) {
              if (hasPrompt(row.threadId, row.archivedAt)) {
                prompt = row;
                break;
              }
              continue;
            }
          } catch (cause) {
            // Only a confirmed missing thread is safe to discard on lookup failure.
            if (!(
              cause &&
              typeof cause === "object" &&
              "status" in cause &&
              cause.status === 404 &&
              "code" in cause &&
              cause.code === "thread_not_found"
            ))
              throw cause;
          }
          // A rearchive during the lookup must not lose its newer prompt.
          removed += db
            .prepare(
              "DELETE FROM prompts WHERE thread_id = ? AND archived_at = ?",
            )
            .run(row.threadId, row.archivedAt).changes;
        }
      } finally {
        // Realtime invalidation also lets clients request the next bounded batch.
        if (removed) changed();
      }
      const count = (
        db.prepare("SELECT count(*) AS total FROM prompts").get() as {
          total: number;
        }
      ).total;
      return { prompt, count };
    },
    dismiss({ threadId, archivedAt }) {
      const removed =
        db
          .prepare(
            "DELETE FROM prompts WHERE thread_id = ? AND archived_at = ?",
          )
          .run(threadId, archivedAt).changes > 0;
      if (removed) changed();
      return { removed };
    },
    getRating: ({ threadId }) => get(threadId),
    async savePrompt({
      threadId,
      archivedAt,
      expectedRevision,
      score,
      useCases,
      note,
    }) {
      if (!hasPrompt(threadId, archivedAt))
        throw new Error("This archive prompt is no longer pending.");
      checkRevision(threadId, expectedRevision);
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(30_000),
      ]);
      const thread = await bb.sdk.threads.get({ threadId, signal });
      if (
        thread.archivedAt !== archivedAt ||
        thread.deletedAt !== null ||
        thread.visibility === "hidden"
      )
        throw new Error(
          "The chat is no longer archived at this point. Dismiss this prompt.",
        );
      const history = await captureHistory((args) =>
        bb.sdk.threads.events.list({
          ...args,
          threadId,
          types: HISTORY_TYPES,
          signal,
        }),
      );
      const rating = db.transaction(() => {
        if (!hasPrompt(threadId, archivedAt))
          throw new Error(
            "This archive prompt was dismissed or changed in another window.",
          );
        const current = checkRevision(threadId, expectedRevision);
        const now = Date.now();
        const next: Rating = {
          threadId,
          projectId: thread.projectId,
          providerId: thread.providerId,
          title: thread.title ?? thread.titleFallback ?? threadId,
          archivedAt,
          score,
          useCases,
          note,
          history,
          revision: nextRevision(),
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        put(next);
        db.prepare(
          "DELETE FROM prompts WHERE thread_id = ? AND archived_at = ?",
        ).run(threadId, archivedAt);
        return next;
      })();
      changed();
      return rating;
    },
    editRating({ threadId, expectedRevision, score, useCases, note }) {
      const next = db.transaction(() => {
        const current = checkRevision(threadId, expectedRevision);
        if (!current) throw new Error("Rating not found.");
        const rating = {
          ...current,
          score,
          useCases,
          note,
          revision: nextRevision(),
          updatedAt: Date.now(),
        };
        put(rating);
        return rating;
      })();
      changed();
      return next;
    },
    deleteRating({ threadId, expectedRevision }) {
      const removed = db.transaction(() => {
        checkRevision(threadId, expectedRevision);
        db.prepare("DELETE FROM observations WHERE thread_id = ?").run(
          threadId,
        );
        return (
          db.prepare("DELETE FROM ratings WHERE thread_id = ?").run(threadId)
            .changes > 0
        );
      })();
      changed();
      return { removed };
    },
    list({ offset }) {
      const rows = db
        .prepare(
          "SELECT record FROM ratings ORDER BY json_extract(record, '$.updatedAt') DESC, thread_id LIMIT 20 OFFSET ?",
        )
        .all(offset) as { record: string }[];
      const ratings = rows.map((row) => {
        const rating = ratingSchema.parse(
          normalizeStoredRating(JSON.parse(row.record)),
        );
        const { observations, ...history } = rating.history;
        const variations = summarizeVariations(observations);
        return {
          ...rating,
          history,
          variations: variations.slice(0, 50),
          variationCount: variations.length,
        };
      });
      return {
        ratings,
        total: (
          db.prepare("SELECT count(*) AS total FROM ratings").get() as {
            total: number;
          }
        ).total,
      };
    },
    exportPage({ afterThreadId }) {
      const row = db
        .prepare(
          "SELECT thread_id FROM ratings WHERE thread_id > ? ORDER BY thread_id LIMIT 1",
        )
        .get(afterThreadId) as { thread_id: string } | undefined;
      return { rating: row ? get(row.thread_id) : null };
    },
  });
}

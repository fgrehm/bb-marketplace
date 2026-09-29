import type { BbPluginApi } from "@get-bb/plugin-sdk";

const ARCHIVE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const LOOKUP_TIMEOUT_MS = 10_000;
const PASS_TIMEOUT_MS = 60_000;
const CURSOR_KEY = "review-cleanup-cursor";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export function registerReviewCleanup(bb: BbPluginApi, db: Database): void {
  const lifecycle = new AbortController();
  let running: Promise<void> | null = null;
  let lookup: { threadId: string; invalidated: boolean } | null = null;
  const owners = db.prepare(
    "SELECT DISTINCT thread_id FROM review_revisions WHERE thread_id > ? ORDER BY thread_id LIMIT ?",
  );
  const purge = db.prepare("DELETE FROM review_revisions WHERE thread_id = ?");

  // All revision-owned tables cascade, including annotation suggestions.
  // Imported comments have their own revision and only textual provenance.
  function purgeThread(threadId: string): number {
    return purge.run(threadId).changes;
  }
  function invalidateLookup(threadId: string): void {
    if (lookup?.threadId === threadId) lookup.invalidated = true;
  }
  bb.events.on("thread.archived", ({ thread }) => invalidateLookup(thread.id));
  bb.events.on("thread.unarchived", ({ thread }) =>
    invalidateLookup(thread.id),
  );
  bb.events.on("thread.deleted", ({ thread }) => {
    invalidateLookup(thread.id);
    const deleted = purgeThread(thread.id);
    if (deleted)
      bb.log.info(
        `Review cleanup deleted ${deleted} revision(s) for a deleted thread.`,
      );
  });
  bb.onDispose(() => lifecycle.abort());

  async function cleanupPass(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const saved = await bb.storage.kv.get<unknown>(CURSOR_KEY);
    if (signal.aborted) return;
    let cursor = typeof saved === "string" ? saved : "";
    let rows = owners.all(cursor, BATCH_SIZE) as Array<{ thread_id: string }>;
    if (!rows.length && cursor) {
      cursor = "";
      rows = owners.all(cursor, BATCH_SIZE) as Array<{ thread_id: string }>;
    }
    if (!rows.length) return;
    const cutoff = Date.now() - ARCHIVE_GRACE_MS;
    const deadline = AbortSignal.timeout(PASS_TIMEOUT_MS);
    const passSignal = AbortSignal.any([signal, deadline]);
    let checked = 0,
      deleted = 0,
      failed = 0;
    for (const { thread_id: threadId } of rows) {
      if (passSignal.aborted) break;
      const current = { threadId, invalidated: false };
      lookup = current;
      let shouldPurge = false;
      try {
        const thread = await bb.sdk.threads.get({
          threadId,
          signal: AbortSignal.any([
            passSignal,
            AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
          ]),
        });
        if (passSignal.aborted) break;
        shouldPurge =
          !current.invalidated &&
          (thread.deletedAt !== null ||
            (thread.archivedAt !== null && thread.archivedAt <= cutoff));
      } catch (cause) {
        if (passSignal.aborted) break;
        if (
          !current.invalidated &&
          cause &&
          typeof cause === "object" &&
          "status" in cause &&
          cause.status === 404 &&
          "code" in cause &&
          cause.code === "thread_not_found"
        )
          shouldPurge = true;
        else failed++;
      } finally {
        lookup = null;
      }
      if (shouldPurge) deleted += purgeThread(threadId);
      cursor = threadId;
      checked++;
    }
    // Keep partial progress on timeout, but never write through a disposed
    // generation. A full short page means the next pass can start a new cycle.
    if (signal.aborted) return;
    if (checked === rows.length && rows.length < BATCH_SIZE) cursor = "";
    await bb.storage.kv.set(CURSOR_KEY, cursor);
    if (signal.aborted) return;
    if (failed)
      bb.log.warn(
        `Review cleanup retained ${failed} thread(s) after metadata lookup failures; a later pass will retry.`,
      );
    if (deadline.aborted)
      bb.log.warn(
        "Review cleanup reached its time limit; a later pass will resume.",
      );
    bb.log.info(
      `Review cleanup checked ${checked} thread(s) and deleted ${deleted} revision(s).`,
    );
  }

  function run(signal?: AbortSignal): Promise<void> {
    if (lifecycle.signal.aborted || signal?.aborted) return Promise.resolve();
    // Startup and cron can coincide. Keep one cursor owner and one SDK lookup
    // in flight, so neither sweep can skip the other's work.
    if (!running) {
      running = cleanupPass(
        signal ? AbortSignal.any([lifecycle.signal, signal]) : lifecycle.signal,
      ).finally(() => {
        running = null;
      });
    }
    return running;
  }
  bb.background.service("cleanup-startup", { start: (signal) => run(signal) });
  bb.background.schedule("cleanup", "17 * * * *", () => run());
}

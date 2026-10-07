import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeSdk } from "@get-bb/plugin-sdk/testing";
import { createThreadJournalStore } from "../thread-journal";

const threadId = "thr_journal1";
const location = {
  hostId: "host-storage",
  storageRootPath: "/bb/threads/thr_journal1",
};
const interaction = {
  turnId: "turn-1",
  messageId: "message:one",
  contributionBody: "Agent text\n---\nverbatim 💾",
  replyBody: "Unfinished reply\n\nwith paragraphs",
  replyStatus: "unfinished" as const,
  revision: 1,
  sourceSeqStart: 2,
  sourceSeqEnd: 2,
};
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function createFiles() {
  const entries = new Map<string, string>();
  const calls: { operation: string; input: unknown }[] = [];
  let failRemove = false;
  const { sdk } = createFakeSdk({
    pluginId: "lazy-chat",
    overrides: {
      files: {
        read: async (input) => {
          calls.push({ operation: "read", input });
          const content = entries.get(input.path);
          if (content === undefined)
            throw Object.assign(new Error("missing"), {
              status: 404,
              code: "ENOENT",
            });
          return {
            path: input.path,
            content,
            contentEncoding: "utf8",
            sizeBytes: Buffer.byteLength(content),
            sha256: sha256(content),
          };
        },
        write: async (input) => {
          calls.push({ operation: "write", input });
          const current = entries.get(input.path);
          const currentSha256 = current === undefined ? null : sha256(current);
          if (
            input.expectedSha256 !== undefined &&
            input.expectedSha256 !== currentSha256
          )
            return { outcome: "conflict", currentSha256 };
          entries.set(input.path, input.content);
          return {
            outcome: "written",
            sha256: sha256(input.content),
            sizeBytes: Buffer.byteLength(input.content),
          };
        },
        remove: async (input) => {
          calls.push({ operation: "remove", input });
          if (failRemove) {
            failRemove = false;
            return { ok: false };
          }
          entries.delete(input.path);
          return { ok: true };
        },
        list: async (input) => {
          calls.push({ operation: "list", input });
          return { files: [], truncated: false };
        },
      },
    },
  });
  return {
    entries,
    calls,
    files: sdk.files,
    failNextRemove() {
      failRemove = true;
    },
  };
}

describe("thread journal persistence", () => {
  it("stores the active round in one thread-scoped current file then consolidates exactly once", async () => {
    const remote = createFiles();
    const store = createThreadJournalStore(remote.files, location, threadId);
    const saved = await store.saveCurrent(interaction, null);
    expect(saved.status).toBe("ok");
    if (saved.status !== "ok") throw new Error("current save failed");
    expect([...remote.entries.keys()]).toEqual([".lazyai/bb/current.md"]);
    expect(remote.calls.filter((call) => call.operation === "write")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({
            hostId: location.hostId,
            rootPath: location.storageRootPath,
            path: ".lazyai/bb/current.md",
          }),
        }),
      ]),
    );

    const consolidated = await store.consolidateCurrent(saved.sha256);
    expect(consolidated.status).toBe("ok");
    expect([...remote.entries.keys()]).toEqual([".lazyai/bb/conversation.md"]);
    const journal = remote.entries.get(".lazyai/bb/conversation.md")!;
    expect(journal).toContain("lazyaiVersion: 3");
    expect(journal).toContain(interaction.contributionBody);
    expect(journal).toContain(interaction.replyBody);
    expect(journal.match(/## Interaction /gu)).toHaveLength(1);
    expect(await store.consolidateCurrent(saved.sha256)).toMatchObject({
      status: "conflict",
    });
  });

  it("keeps recoverable current data when cleanup fails and retries without duplicate journal entries", async () => {
    const remote = createFiles();
    const store = createThreadJournalStore(remote.files, location, threadId);
    const saved = await store.saveCurrent(interaction, null);
    expect(saved.status).toBe("ok");
    if (saved.status !== "ok") throw new Error("current save failed");
    remote.failNextRemove();
    expect(await store.consolidateCurrent(saved.sha256)).toMatchObject({
      status: "error",
    });
    const retained = await store.loadCurrent();
    expect(retained).toMatchObject({
      status: "ok",
      value: {
        turnId: interaction.turnId,
        messageId: interaction.messageId,
        contributionBody: interaction.contributionBody,
        replyBody: interaction.replyBody,
      },
    });
    if (retained.status !== "ok") throw new Error("current record was lost");
    expect(await store.consolidateCurrent(retained.sha256)).toMatchObject({
      status: "ok",
    });
    expect(remote.entries.has(".lazyai/bb/current.md")).toBe(false);
    expect(
      remote.entries
        .get(".lazyai/bb/conversation.md")
        ?.match(/## Interaction /gu),
    ).toHaveLength(1);
  });

  it("serializes interaction entries by source sequence rather than opaque IDs", async () => {
    const remote = createFiles();
    const store = createThreadJournalStore(remote.files, location, threadId);
    const laterLexicallyEarlier = {
      ...interaction,
      turnId: "t10",
      messageId: "message-10",
      sourceSeqStart: 20,
      sourceSeqEnd: 20,
    };
    const earlierLexicallyLater = {
      ...interaction,
      turnId: "t2",
      messageId: "message-2",
      sourceSeqStart: 10,
      sourceSeqEnd: 10,
    };
    expect(
      await store.mergeInteractions([
        laterLexicallyEarlier,
        earlierLexicallyLater,
      ]),
    ).toMatchObject({ status: "ok" });
    const journal = remote.entries.get(".lazyai/bb/conversation.md")!;
    expect(journal.indexOf('"t2","message-2"')).toBeLessThan(
      journal.indexOf('"t10","message-10"'),
    );
  });

  it("updates pending user-message status to accepted idempotently", async () => {
    const remote = createFiles();
    const store = createThreadJournalStore(remote.files, location, threadId);
    const pending = {
      messageId: "user-message-1",
      turnId: "turn-2",
      sourceSeqStart: 4,
      sourceSeqEnd: 4,
      turnRequestStatus: "pending" as const,
      body: "Exact user text",
    };
    expect(await store.mergeUserMessages([pending])).toMatchObject({
      status: "ok",
    });
    const accepted = { ...pending, turnRequestStatus: "accepted" as const };
    expect(await store.mergeUserMessages([accepted])).toMatchObject({
      status: "ok",
      value: { userMessages: [accepted] },
    });
    expect(await store.mergeUserMessages([accepted])).toMatchObject({
      status: "ok",
      value: { userMessages: [accepted] },
    });
    expect(await store.mergeUserMessages([pending])).toMatchObject({
      status: "conflict",
    });
  });

  it("refuses stale current revisions and retains the newer file", async () => {
    const remote = createFiles();
    const store = createThreadJournalStore(remote.files, location, threadId);
    const saved = await store.saveCurrent(interaction, null);
    expect(saved.status).toBe("ok");
    if (saved.status !== "ok") throw new Error("current save failed");
    const changed = await store.saveCurrent(
      { ...interaction, revision: 2, replyBody: "newer edit" },
      saved.sha256,
    );
    expect(changed.status).toBe("ok");
    expect(await store.consolidateCurrent(saved.sha256)).toMatchObject({
      status: "conflict",
    });
    expect(await store.loadCurrent()).toMatchObject({
      status: "ok",
      value: { revision: 2, replyBody: "newer edit" },
    });
  });
});

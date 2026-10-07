import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { serializeMarkdownRecord } from "../markdown-record";

const threadId = "thr_thread1";
const turnId = "turn-1";
const itemId = "item-1";
const secondItemId = "item-2";
const messageId = `${threadId}:assistant:kind:assistant|turn:${turnId}|parent:root|item:${itemId}`;
const secondMessageId = `${threadId}:assistant:kind:assistant|turn:${turnId}|parent:root|item:${secondItemId}`;
type FileReadArgs = Parameters<BbPluginApi["sdk"]["files"]["read"]>[0];
type FileWriteArgs = Parameters<BbPluginApi["sdk"]["files"]["write"]>[0];

function createHost({
  newerUser = false,
  nested = false,
  secondRoot = false,
  status = "idle",
  completionStatus = "completed",
  workspacePath = "/workspace/project",
  storageRootPath = "/bb/thread-storage/thr_thread1",
  legacyRecords = [] as { path: string; content: string }[],
  badHashPath,
}: {
  newerUser?: boolean;
  nested?: boolean;
  secondRoot?: boolean;
  status?: string;
  completionStatus?: string;
  workspacePath?: string | null;
  storageRootPath?: string;
  legacyRecords?: { path: string; content: string }[];
  badHashPath?: string;
} = {}) {
  const fileEntries = new Map<string, string>(
    legacyRecords.map(({ path, content }) => [path, content]),
  );
  const storageCalls: string[] = [];
  const sha256 = (content: string) =>
    createHash("sha256").update(content, "utf8").digest("hex");
  const events = [
    {
      id: "start",
      scope: { kind: "turn", turnId },
      threadId,
      seq: 1,
      createdAt: 1,
      type: "turn/started",
      data: {},
    },
    {
      id: "item",
      scope: { kind: "turn", turnId },
      threadId,
      seq: 2,
      createdAt: 2,
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          id: itemId,
          ...(nested ? { parentToolCallId: "tool-1" } : {}),
        },
      },
    },
    ...(secondRoot
      ? [
          {
            id: "item-2",
            scope: { kind: "turn", turnId },
            threadId,
            seq: 3,
            createdAt: 3,
            type: "item/completed",
            data: { item: { type: "agentMessage", id: secondItemId } },
          },
        ]
      : []),
    {
      id: "complete",
      scope: { kind: "turn", turnId },
      threadId,
      seq: secondRoot ? 4 : 3,
      createdAt: secondRoot ? 4 : 3,
      type: "turn/completed",
      data: { status: completionStatus },
    },
    ...(newerUser
      ? [
          {
            id: "next",
            scope: { kind: "turn", turnId: "turn-2" },
            threadId,
            seq: 4,
            createdAt: 4,
            type: "item/completed",
            data: { item: { type: "userMessage", id: "user-2" } },
          },
        ]
      : []),
  ];
  const host = createFakePluginHost({
    pluginId: "lazy-chat",
    sdk: {
      threads: {
        get: async () => ({
          ...makeThreadResponse({
            id: threadId,
            status: status as "idle" | "active",
          }),
          environmentId: "environment-1",
          projectId: "project-1",
        }),
        events: { list: async () => events },
        storageLocation: async ({
          threadId: requestedThreadId,
        }: {
          threadId: string;
        }) => {
          storageCalls.push(requestedThreadId);
          return {
            hostId: "host-thread-storage",
            storageRootPath:
              requestedThreadId === threadId
                ? storageRootPath
                : `/bb/thread-storage/${requestedThreadId}`,
          };
        },
        timeline: async () => ({
          rows: [
            {
              kind: "conversation",
              role: "assistant",
              id: messageId,
              threadId,
              text: "Original assistant text",
              turnId,
              sourceSeqStart: 2,
              sourceSeqEnd: 2,
            },
            ...(newerUser
              ? [
                  {
                    kind: "conversation" as const,
                    role: "user" as const,
                    id: "actual-user-message-id",
                    threadId,
                    text: "Actual BB reply differs from the plugin draft",
                    turnId: "turn-2",
                    sourceSeqStart: 4,
                    sourceSeqEnd: 4,
                    messageSeq: 4,
                    attachments: null,
                    turnRequest: {
                      isGrouped: false,
                      kind: "message" as const,
                      status: "accepted" as const,
                    },
                  },
                ]
              : []),
            ...(secondRoot
              ? [
                  {
                    kind: "conversation" as const,
                    role: "assistant" as const,
                    id: secondMessageId,
                    threadId,
                    text: "Final assistant text",
                    turnId,
                    sourceSeqStart: 3,
                    sourceSeqEnd: 3,
                  },
                ]
              : []),
          ],
        }),
      },
      environments: {
        get: async () => ({
          id: "environment-1",
          projectId: "project-1",
          hostId: "host-1",
          path: workspacePath,
          status: "ready",
          hostLifecycle: "active",
          lifecycle: { phase: "active", retireAt: null, teardown: null },
          workspaceProvisionType: workspacePath ? "unmanaged" : null,
        }),
      },
      files: {
        read: async ({ path }: FileReadArgs) => {
          const content = fileEntries.get(path);
          if (content === undefined)
            throw Object.assign(new Error("missing"), {
              status: 404,
              code: "ENOENT",
            });
          return {
            path,
            content,
            contentEncoding: "utf8",
            sizeBytes: Buffer.byteLength(content),
            sha256: path === badHashPath ? "0".repeat(64) : sha256(content),
          };
        },
        write: async ({ path, content, expectedSha256 }: FileWriteArgs) => {
          const existing = fileEntries.get(path);
          const currentSha256 =
            existing === undefined ? null : sha256(existing);
          if (expectedSha256 !== undefined && expectedSha256 !== currentSha256)
            return { outcome: "conflict", currentSha256 };
          fileEntries.set(path, content);
          return {
            outcome: "written",
            sha256: sha256(content),
            sizeBytes: Buffer.byteLength(content),
          };
        },
        remove: async ({ path }: { path: string }) => {
          fileEntries.delete(path);
          return { ok: true };
        },
        list: async ({ path }: { path: string }) => ({
          files: [...fileEntries.keys()]
            .filter((candidate) => candidate.startsWith(`${path}/`))
            .map((candidate) => ({
              path: candidate.slice(path.length + 1),
              name: candidate.split("/").at(-1)!,
            })),
          truncated: false,
        }),
      },
    } as never,
  });
  return { ...host, fileEntries, storageCalls };
}

describe("lazy reply ownership RPC", () => {
  it("publishes same-thread activity invalidation signals", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: threadId }),
      sequence: 42,
    });
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "thread-activity",
      payload: { threadId, sequence: 42 },
    });
    await host.harness.lifecycle.dispose();
  });

  it("accepts only the exact current completed top-level assistant contribution", async () => {
    const host = createHost();
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("lazy_reply_eligible", {
        messageId,
        threadId,
        turnId,
      }),
    ).resolves.toEqual({ eligible: true });
    await host.harness.lifecycle.dispose();
  });

  it("rejects mismatched message, thread, and turn ownership", async () => {
    const host = createHost();
    await plugin(host.bb);
    for (const input of [
      { messageId: "other-message", threadId, turnId },
      { messageId, threadId: "other-thread", turnId },
      { messageId, threadId, turnId: "other-turn" },
    ]) {
      await expect(
        host.harness.behavior.callRpc("lazy_reply_eligible", input),
      ).resolves.toEqual({ eligible: false });
    }
    await host.harness.lifecycle.dispose();
  });

  it("allows only the latest root assistant contribution within a multi-message turn", async () => {
    const host = createHost({ secondRoot: true });
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("lazy_reply_eligible", {
        messageId,
        threadId,
        turnId,
      }),
    ).resolves.toEqual({ eligible: false });
    await expect(
      host.harness.behavior.callRpc("lazy_reply_eligible", {
        messageId: secondMessageId,
        threadId,
        turnId,
      }),
    ).resolves.toEqual({ eligible: true });
    await host.harness.lifecycle.dispose();
  });

  it("loads and saves in thread storage using timeline source text", async () => {
    const host = createHost();
    await plugin(host.bb);
    const identity = { messageId, threadId, turnId };
    await expect(
      host.harness.behavior.callRpc("lazy_reply_load", identity),
    ).resolves.toEqual({
      status: "loaded",
      contributionBody: "Original assistant text",
      draftBody: null,
      draftSha256: null,
    });
    const saved = await host.harness.behavior.callRpc("lazy_reply_save", {
      ...identity,
      body: "A persisted reply",
      expectedSha256: null,
    });
    expect(saved).toMatchObject({ status: "saved" });
    await expect(
      host.harness.behavior.callRpc("lazy_reply_load", identity),
    ).resolves.toMatchObject({
      status: "loaded",
      contributionBody: "Original assistant text",
      draftBody: "A persisted reply",
    });
    expect([...host.fileEntries.keys()]).toEqual([".lazyai/bb/current.md"]);
    expect(host.storageCalls).toEqual([threadId, threadId, threadId]);
    await host.harness.lifecycle.dispose();
  });

  it("merges and verifies this thread's legacy workspace records before cleanup", async () => {
    const legacyRoot = `/workspace/project/.lazyai/bb/${threadId}/turn-1`;
    const contribution = serializeMarkdownRecord({
      version: 1,
      kind: "contribution",
      threadId,
      turnId,
      messageId,
      attribution: "agent",
      draftStatus: "immutable",
      body: "Original assistant text",
    });
    const draft = serializeMarkdownRecord({
      version: 1,
      kind: "draft",
      threadId,
      turnId,
      messageId,
      attribution: "human",
      draftStatus: "active",
      body: "Legacy unfinished reply",
    });
    const host = createHost({
      legacyRecords: [
        { path: `${legacyRoot}/contribution.md`, content: contribution },
        { path: `${legacyRoot}/draft.md`, content: draft },
        {
          path: `/workspace/project/.lazyai/bb/thr_other/turn-9/draft.md`,
          content: draft,
        },
      ],
    });
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("lazy_reply_load", {
        messageId,
        threadId,
        turnId,
      }),
    ).resolves.toMatchObject({
      status: "loaded",
      contributionBody: "Original assistant text",
      draftBody: "Legacy unfinished reply",
    });
    expect([...host.fileEntries.keys()]).toContain(
      ".lazyai/bb/conversation.md",
    );
    expect(host.fileEntries.has(`${legacyRoot}/contribution.md`)).toBe(false);
    expect(host.fileEntries.has(`${legacyRoot}/draft.md`)).toBe(false);
    expect(
      host.fileEntries.has(
        "/workspace/project/.lazyai/bb/thr_other/turn-9/draft.md",
      ),
    ).toBe(true);
    await host.harness.lifecycle.dispose();
  });

  it("retains legacy sources and imports nothing when the SDK read hash is wrong", async () => {
    const legacyRoot = `/workspace/project/.lazyai/bb/${threadId}/turn-1`;
    const contribution = serializeMarkdownRecord({
      version: 1,
      kind: "contribution",
      threadId,
      turnId,
      messageId,
      attribution: "agent",
      draftStatus: "immutable",
      body: "Original assistant text",
    });
    const path = `${legacyRoot}/contribution.md`;
    const host = createHost({
      legacyRecords: [{ path, content: contribution }],
      badHashPath: path,
    });
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("lazy_reply_load", {
        messageId,
        threadId,
        turnId,
      }),
    ).resolves.toMatchObject({ status: "storage_error" });
    expect(host.fileEntries.has(path)).toBe(true);
    expect(host.fileEntries.has(".lazyai/bb/conversation.md")).toBe(false);
    await host.harness.lifecycle.dispose();
  });

  it("loads an owned prior round without assigning it to newer thread activity", async () => {
    const host = createHost({ newerUser: true });
    await plugin(host.bb);
    const result = await host.harness.behavior.callRpc("lazy_reply_load", {
      messageId,
      threadId,
      turnId,
    });
    expect(result).toMatchObject({
      status: "loaded",
      contributionBody: "Original assistant text",
      draftBody: null,
    });
    expect([...host.fileEntries.keys()]).toEqual([
      ".lazyai/bb/conversation.md",
    ]);
    expect(host.fileEntries.get(".lazyai/bb/conversation.md")).toContain(
      "Actual BB reply differs from the plugin draft",
    );
    await host.harness.lifecycle.dispose();
  });

  it("journals a displaced round flush without claiming the shared current file", async () => {
    const host = createHost({ newerUser: true });
    await plugin(host.bb);
    const saved = await host.harness.behavior.callRpc("lazy_reply_save", {
      messageId,
      threadId,
      turnId,
      body: "late captured old-round edit",
      expectedSha256: null,
    });
    expect(saved).toMatchObject({ status: "saved" });
    expect([...host.fileEntries.keys()]).toEqual([
      ".lazyai/bb/conversation.md",
    ]);
    const journal = host.fileEntries.get(".lazyai/bb/conversation.md")!;
    expect(journal).toContain("late captured old-round edit");
    expect(journal).toContain("Actual BB reply differs from the plugin draft");
    expect(journal).toContain('## User message "actual-user-message-id"');
    expect(journal).toContain("sourceSeqStart: 4");
    expect(journal).toContain("turnRequestStatus: accepted");
    await host.harness.lifecycle.dispose();
  });

  it("uses thread storage even when no project workspace is available", async () => {
    const host = createHost({ workspacePath: null });
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("lazy_reply_load", {
        messageId,
        threadId,
        turnId,
      }),
    ).resolves.toMatchObject({ status: "loaded" });
    expect(host.fileEntries.size).toBe(0);
    await host.harness.lifecycle.dispose();
  });

  it("rejects an earlier root row in the same turn for persistence", async () => {
    const host = createHost({ secondRoot: true });
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("lazy_reply_load", {
        messageId,
        threadId,
        turnId,
      }),
    ).resolves.toEqual({ status: "invalid_round" });
    await expect(
      host.harness.behavior.callRpc("lazy_reply_save", {
        messageId,
        threadId,
        turnId,
        body: "must not be assigned to the final message",
        expectedSha256: null,
      }),
    ).resolves.toEqual({ status: "invalid_round" });
    await host.harness.lifecycle.dispose();
  });

  it("rejects nested, stale, inactive, failed, and interrupted contributions", async () => {
    for (const options of [
      { nested: true },
      { newerUser: true },
      { status: "active" },
      { completionStatus: "failed" },
      { completionStatus: "interrupted" },
    ]) {
      const host = createHost(options);
      await plugin(host.bb);
      await expect(
        host.harness.behavior.callRpc("lazy_reply_eligible", {
          messageId,
          threadId,
          turnId,
        }),
      ).resolves.toEqual({ eligible: false });
      await host.harness.lifecycle.dispose();
    }
  });
});

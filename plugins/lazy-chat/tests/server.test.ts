import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

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
}: {
  newerUser?: boolean;
  nested?: boolean;
  secondRoot?: boolean;
  status?: string;
  completionStatus?: string;
  workspacePath?: string | null;
} = {}) {
  const fileEntries = new Map<string, string>();
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
            sha256: sha256(content),
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
      },
    } as never,
  });
  return { ...host, fileEntries };
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

  it("loads and saves through the thread environment using timeline source text", async () => {
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
    expect([...host.fileEntries.keys()]).toEqual([
      "/workspace/project/.lazyai/bb/thr_thread1/turn-1/contribution.md",
      "/workspace/project/.lazyai/bb/thr_thread1/turn-1/draft.md",
    ]);
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
    expect(
      [...host.fileEntries.keys()].every((path) => path.includes(turnId)),
    ).toBe(true);
    await host.harness.lifecycle.dispose();
  });

  it("reports non-workspace environments without falling back to server files", async () => {
    const host = createHost({ workspacePath: null });
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("lazy_reply_load", {
        messageId,
        threadId,
        turnId,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "not_workspace" });
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

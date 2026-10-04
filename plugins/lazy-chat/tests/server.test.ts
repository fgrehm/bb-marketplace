import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const threadId = "thread-1";
const turnId = "turn-1";
const itemId = "item-1";
const secondItemId = "item-2";
const messageId = `${threadId}:assistant:kind:assistant|turn:${turnId}|parent:root|item:${itemId}`;
const secondMessageId = `${threadId}:assistant:kind:assistant|turn:${turnId}|parent:root|item:${secondItemId}`;

function createHost({
  newerUser = false,
  nested = false,
  secondRoot = false,
  status = "idle",
  completionStatus = "completed",
} = {}) {
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
  return createFakePluginHost({
    pluginId: "lazy-chat",
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({
            id: threadId,
            status: status as "idle" | "active",
          }),
        events: { list: async () => events },
        timeline: async () => ({
          rows: [
            {
              kind: "conversation",
              role: "assistant",
              id: messageId,
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
                    turnId,
                    sourceSeqStart: 3,
                    sourceSeqEnd: 3,
                  },
                ]
              : []),
          ],
        }),
      },
    } as never,
  });
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

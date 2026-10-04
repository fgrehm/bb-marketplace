import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  lazy_reply_eligible: {
    input: z.object({
      messageId: z.string(),
      threadId: z.string(),
      turnId: z.string(),
    }),
    output: z.object({ eligible: z.boolean() }),
  },
});

export default function register(api: BbPluginApi) {
  api.events.on("experimental_thread.events", ({ thread, sequence }) => {
    api.realtime.publish("thread-activity", {
      threadId: thread.id,
      sequence,
    });
  });
  api.rpc.register(rpcContract, {
    async lazy_reply_eligible({ messageId, threadId, turnId }) {
      const [thread, events, timeline] = await Promise.all([
        api.sdk.threads.get({ threadId }),
        api.sdk.threads.events.list({ threadId, limit: "100", order: "desc" }),
        api.sdk.threads.timeline({ threadId }),
      ]);
      if (
        thread.id !== threadId ||
        thread.status !== "idle" ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null
      ) {
        return { eligible: false };
      }
      const turnStarted = events.find(
        (event) =>
          event.type === "turn/started" &&
          event.scope.kind === "turn" &&
          event.scope.turnId === turnId,
      );
      const turnCompleted = events.find(
        (event) =>
          event.type === "turn/completed" &&
          event.scope.kind === "turn" &&
          event.scope.turnId === turnId,
      );
      if (
        !turnStarted ||
        !turnCompleted ||
        turnCompleted.type !== "turn/completed" ||
        turnStarted.seq > turnCompleted.seq ||
        turnCompleted.data.status !== "completed"
      ) {
        api.log.info(
          `lazy reply ownership check: turn events missing for ${messageId}/${turnId}`,
        );
        return { eligible: false };
      }
      const completedAgentItems = events.flatMap((event) => {
        if (
          event.type !== "item/completed" ||
          event.scope.kind !== "turn" ||
          event.scope.turnId !== turnId ||
          event.seq > turnCompleted.seq
        )
          return [];
        const item = event.data.item;
        return item.type === "agentMessage" &&
          item.parentToolCallId === undefined
          ? [{ seq: event.seq }]
          : [];
      });
      const latestAgentItem = completedAgentItems.reduce(
        (latest, item) => (item.seq > (latest?.seq ?? -1) ? item : latest),
        undefined as { seq: number } | undefined,
      );
      const currentContribution = latestAgentItem
        ? timeline.rows.find(
            (row) =>
              row.kind === "conversation" &&
              row.role === "assistant" &&
              row.turnId === turnId &&
              row.sourceSeqStart <= latestAgentItem.seq &&
              latestAgentItem.seq <= row.sourceSeqEnd,
          )
        : undefined;
      if (!currentContribution || currentContribution.id !== messageId)
        return { eligible: false };
      const newerThreadActivity = events.some(
        (event) =>
          event.seq > turnCompleted.seq &&
          (event.type === "turn/started" ||
            (event.type === "item/completed" &&
              event.data.item.type === "userMessage")),
      );
      return { eligible: !newerThreadActivity };
    },
  });
}

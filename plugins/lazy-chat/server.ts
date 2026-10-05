import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createMarkdownStore } from "./markdown-store";
import { rpcContract } from "./rpc";
export { rpcContract } from "./rpc";

type ReplyIdentity = { messageId: string; threadId: string; turnId: string };
type TimelineRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>
>["rows"][number];
type AssistantConversationRow = Extract<
  TimelineRow,
  { kind: "conversation"; role: "assistant" }
>;
function isAssistantConversation(
  row: TimelineRow,
): row is AssistantConversationRow {
  return row.kind === "conversation" && row.role === "assistant";
}
type OwnedRound = {
  thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
  contribution: AssistantConversationRow;
  latestMessageId: string | null;
  completedSeq: number;
  hasNewerActivity: boolean;
};

async function inspectOwnedRound(
  api: BbPluginApi,
  identity: ReplyIdentity,
): Promise<OwnedRound | null> {
  const [thread, events, timeline] = await Promise.all([
    api.sdk.threads.get({ threadId: identity.threadId }),
    api.sdk.threads.events.list({
      threadId: identity.threadId,
      limit: "100",
      order: "desc",
    }),
    api.sdk.threads.timeline({ threadId: identity.threadId }),
  ]);
  if (thread.id !== identity.threadId || thread.deletedAt !== null) return null;
  const started = events.find(
    (event) =>
      event.type === "turn/started" &&
      event.scope.kind === "turn" &&
      event.scope.turnId === identity.turnId,
  );
  const completed = events.find(
    (event) =>
      event.type === "turn/completed" &&
      event.scope.kind === "turn" &&
      event.scope.turnId === identity.turnId,
  );
  if (
    !started ||
    !completed ||
    completed.type !== "turn/completed" ||
    started.seq > completed.seq ||
    completed.data.status !== "completed"
  )
    return null;
  const agentItems = events.flatMap((event) => {
    if (
      event.type !== "item/completed" ||
      event.scope.kind !== "turn" ||
      event.scope.turnId !== identity.turnId ||
      event.seq > completed.seq
    )
      return [];
    const item = event.data.item;
    return item.type === "agentMessage" && item.parentToolCallId === undefined
      ? [{ seq: event.seq }]
      : [];
  });
  const latestAgentItem = agentItems.reduce(
    (latest, item) => (item.seq > (latest?.seq ?? -1) ? item : latest),
    undefined as { seq: number } | undefined,
  );
  const assistantRows = timeline.rows.filter(isAssistantConversation);
  const contribution = assistantRows.find(
    (row) =>
      row.threadId === identity.threadId &&
      row.id === identity.messageId &&
      row.turnId === identity.turnId &&
      agentItems.some(
        (item) =>
          row.sourceSeqStart <= item.seq && item.seq <= row.sourceSeqEnd,
      ),
  );
  if (!contribution || !latestAgentItem) return null;
  const latestContribution = assistantRows.find(
    (row) =>
      row.threadId === identity.threadId &&
      row.turnId === identity.turnId &&
      row.sourceSeqStart <= latestAgentItem.seq &&
      latestAgentItem.seq <= row.sourceSeqEnd,
  );
  if (!latestContribution || latestContribution.id !== identity.messageId)
    return null;
  return {
    thread,
    contribution,
    latestMessageId: latestContribution.id,
    completedSeq: completed.seq,
    hasNewerActivity: events.some(
      (event) =>
        event.seq > completed.seq &&
        (event.type === "turn/started" ||
          (event.type === "item/completed" &&
            event.data.item.type === "userMessage")),
    ),
  };
}

async function resolveStorage(api: BbPluginApi, round: OwnedRound) {
  const environmentId = round.thread.environmentId;
  if (!environmentId)
    return {
      status: "unavailable" as const,
      reason: "missing_environment" as const,
    };
  let environment;
  try {
    environment = await api.sdk.environments.get({ environmentId });
  } catch {
    return {
      status: "unavailable" as const,
      reason: "missing_environment" as const,
    };
  }
  if (
    environment.id !== environmentId ||
    environment.projectId !== round.thread.projectId ||
    environment.status !== "ready" ||
    environment.hostLifecycle !== "active" ||
    environment.lifecycle.phase !== "active"
  )
    return { status: "unavailable" as const, reason: "not_ready" as const };
  if (
    !environment.path ||
    !environment.hostId ||
    !environment.workspaceProvisionType
  )
    return { status: "unavailable" as const, reason: "not_workspace" as const };
  return {
    status: "ready" as const,
    location: { hostId: environment.hostId, rootPath: environment.path },
  };
}

async function loadReplyDraft(api: BbPluginApi, identity: ReplyIdentity) {
  const round = await inspectOwnedRound(api, identity);
  if (!round) return { status: "invalid_round" as const };
  const resolved = await resolveStorage(api, round);
  if (resolved.status !== "ready") return resolved;
  const store = createMarkdownStore(api.sdk.files, resolved.location);
  const contributionWrite = await store.saveContribution({
    version: 1,
    kind: "contribution",
    threadId: identity.threadId,
    turnId: identity.turnId,
    messageId: identity.messageId,
    attribution: "agent",
    draftStatus: "immutable",
    body: round.contribution.text,
  });
  if (
    contributionWrite.status !== "created" &&
    contributionWrite.status !== "reused"
  )
    return {
      status: "storage_error" as const,
      reason:
        contributionWrite.status === "io_error"
          ? ("write_failed" as const)
          : ("corrupt" as const),
    };
  if (round.contribution.text.length > 1_000_000)
    return { status: "storage_error" as const, reason: "corrupt" as const };
  const draft = await store.loadDraft(identity);
  if (draft.status === "missing")
    return {
      status: "loaded" as const,
      contributionBody: round.contribution.text,
      draftBody: null,
      draftSha256: null,
    };
  if (draft.status !== "loaded")
    return {
      status: "storage_error" as const,
      reason:
        draft.status === "io_error"
          ? ("read_failed" as const)
          : ("corrupt" as const),
    };
  if (draft.record.body.length > 1_000_000)
    return { status: "storage_error" as const, reason: "corrupt" as const };
  return {
    status: "loaded" as const,
    contributionBody: round.contribution.text,
    draftBody: draft.record.body,
    draftSha256: draft.sha256,
  };
}

async function saveReplyDraft(
  api: BbPluginApi,
  input: ReplyIdentity & { body: string; expectedSha256: string | null },
) {
  const round = await inspectOwnedRound(api, input);
  if (!round) return { status: "invalid_round" as const };
  const resolved = await resolveStorage(api, round);
  if (resolved.status !== "ready") return resolved;
  const store = createMarkdownStore(api.sdk.files, resolved.location);
  const contributionWrite = await store.saveContribution({
    version: 1,
    kind: "contribution",
    threadId: input.threadId,
    turnId: input.turnId,
    messageId: input.messageId,
    attribution: "agent",
    draftStatus: "immutable",
    body: round.contribution.text,
  });
  if (
    contributionWrite.status !== "created" &&
    contributionWrite.status !== "reused"
  )
    return {
      status: "storage_error" as const,
      reason:
        contributionWrite.status === "io_error"
          ? ("write_failed" as const)
          : ("corrupt" as const),
    };
  if (
    input.body.length > 1_000_000 ||
    round.contribution.text.length > 1_000_000
  )
    return { status: "storage_error" as const, reason: "corrupt" as const };
  const draftRecord = {
    version: 1 as const,
    kind: "draft" as const,
    threadId: input.threadId,
    turnId: input.turnId,
    messageId: input.messageId,
    attribution: "human" as const,
    draftStatus: "active" as const,
    body: input.body,
  };
  const saved =
    input.expectedSha256 === null
      ? await store.createDraft(draftRecord)
      : await store.updateDraft(draftRecord, input.expectedSha256);
  if (
    saved.status === "created" ||
    saved.status === "updated" ||
    saved.status === "reused"
  )
    return { status: "saved" as const, sha256: saved.sha256 };
  if (saved.status === "conflict" || saved.status === "missing") {
    const disk = await store.loadDraft(input);
    if (disk.status === "loaded")
      return {
        status: "conflict" as const,
        diskBody: disk.record.body,
        diskSha256: disk.sha256,
      };
    if (disk.status === "missing")
      return { status: "conflict" as const, diskBody: null, diskSha256: null };
    return {
      status: "storage_error" as const,
      reason:
        disk.status === "io_error"
          ? ("read_failed" as const)
          : ("corrupt" as const),
    };
  }
  return {
    status: "storage_error" as const,
    reason:
      saved.status === "io_error"
        ? ("write_failed" as const)
        : ("corrupt" as const),
  };
}

export default function register(api: BbPluginApi) {
  api.events.on("experimental_thread.events", ({ thread, sequence }) => {
    api.realtime.publish("thread-activity", {
      threadId: thread.id,
      sequence,
    });
  });
  api.rpc.register(rpcContract, {
    async lazy_reply_eligible(identity) {
      const round = await inspectOwnedRound(api, identity);
      return {
        eligible:
          round !== null &&
          round.thread.status === "idle" &&
          round.thread.archivedAt === null &&
          round.latestMessageId === identity.messageId &&
          !round.hasNewerActivity,
      };
    },
    async lazy_reply_load(identity) {
      try {
        return await loadReplyDraft(api, identity);
      } catch {
        return {
          status: "storage_error" as const,
          reason: "read_failed" as const,
        };
      }
    },
    async lazy_reply_save(input) {
      try {
        return await saveReplyDraft(api, input);
      } catch {
        return {
          status: "storage_error" as const,
          reason: "write_failed" as const,
        };
      }
    },
  });
}

import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseMarkdownRecord } from "./markdown-record";
import { createThreadJournalStore } from "./thread-journal";
import type { ThreadInteraction, ThreadUserMessage } from "./thread-journal";
import { rpcContract } from "./rpc";
export { rpcContract } from "./rpc";

type ReplyIdentity = { messageId: string; threadId: string; turnId: string };

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
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
  hasNewerActivity: boolean;
  timelineRows: TimelineRow[];
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
    timelineRows: timeline.rows,
    hasNewerActivity: events.some(
      (event) =>
        event.seq > completed.seq &&
        (event.type === "turn/started" ||
          (event.type === "item/completed" &&
            event.data.item.type === "userMessage")),
    ),
  };
}

async function storeFor(api: BbPluginApi, threadId: string) {
  const location = await api.sdk.threads.storageLocation({ threadId });
  return createThreadJournalStore(api.sdk.files, location, threadId);
}

function observedUserMessages(round: OwnedRound): ThreadUserMessage[] {
  return round.timelineRows.flatMap((row) =>
    row.kind === "conversation" &&
    row.role === "user" &&
    row.threadId === round.thread.id
      ? [
          {
            messageId: row.id,
            turnId: row.turnId,
            sourceSeqStart: row.sourceSeqStart,
            sourceSeqEnd: row.sourceSeqEnd,
            turnRequestStatus: row.turnRequest.status,
            body: row.text,
          },
        ]
      : [],
  );
}

async function persistObservedUserMessages(
  round: OwnedRound,
  store: Awaited<ReturnType<typeof storeFor>>,
) {
  const messages = observedUserMessages(round);
  return messages.length > 0 ? store.mergeUserMessages(messages) : null;
}

async function migrateLegacyRecords(
  api: BbPluginApi,
  round: OwnedRound,
  threadId: string,
  store: Awaited<ReturnType<typeof storeFor>>,
) {
  if (!round.thread.environmentId) return;
  const environment = await api.sdk.environments.get({
    environmentId: round.thread.environmentId,
  });
  if (!environment.hostId || !environment.path) return;
  const legacyRoot = `${environment.path.replace(/[\\/]+$/u, "")}/.lazyai/bb/${threadId}`;
  const listing = await api.sdk.files.list({
    hostId: environment.hostId,
    path: legacyRoot,
    includeHidden: true,
    limit: 1000,
  });
  if (listing.truncated)
    throw new Error("Legacy records exceed the bounded migration limit");
  const sources = listing.files.flatMap((file) => {
    const normalized = file.path.replace(/\\/gu, "/");
    const relative = normalized.startsWith(`${legacyRoot}/`)
      ? normalized.slice(legacyRoot.length + 1)
      : normalized;
    return /^([A-Za-z0-9_-]{1,128})\/(contribution|draft)\.md$/u.test(relative)
      ? [{ path: `${legacyRoot}/${relative}`, relative }]
      : [];
  });
  const grouped = new Map<
    string,
    {
      contribution?: ReturnType<typeof parseMarkdownRecord>;
      draft?: ReturnType<typeof parseMarkdownRecord>;
    }
  >();
  const sourceContents: { path: string; content: string; sha256: string }[] =
    [];
  for (const source of sources) {
    const [turnId, name] = source.relative.split("/");
    const response = await api.sdk.files.read({
      hostId: environment.hostId,
      rootPath: environment.path,
      path: source.path,
    });
    if (response.content.startsWith("<!-- lazy-chat migrated ")) continue;
    if (response.contentEncoding !== "utf8")
      throw new Error("Legacy Markdown record is not UTF-8");
    if (sha256(response.content) !== response.sha256)
      throw new Error("Legacy Markdown read hash does not match content");
    const record = parseMarkdownRecord(response.content);
    if (
      record.threadId !== threadId ||
      record.turnId !== turnId ||
      (name === "contribution.md"
        ? record.kind !== "contribution"
        : record.kind !== "draft")
    )
      continue;
    const key = JSON.stringify([record.turnId, record.messageId]);
    const pair = grouped.get(key) ?? {};
    if (name === "contribution.md") pair.contribution = record;
    else pair.draft = record;
    grouped.set(key, pair);
    sourceContents.push({
      path: source.path,
      content: response.content,
      sha256: response.sha256,
    });
  }
  if (grouped.size === 0) return;
  const interactions: ThreadInteraction[] = [...grouped.values()].map(
    ({ contribution, draft }) => {
      const record = contribution ?? draft!;
      const source = round.timelineRows.find(
        (row) =>
          row.kind === "conversation" &&
          row.role === "assistant" &&
          row.id === record.messageId,
      );
      if (!source)
        throw new Error(
          "Legacy message identity is absent from public timeline",
        );
      return {
        turnId: record.turnId,
        messageId: record.messageId,
        revision: 1,
        sourceSeqStart: source.sourceSeqStart,
        sourceSeqEnd: source.sourceSeqEnd,
        contributionBody: contribution?.body ?? "",
        replyBody: draft?.body ?? "",
        replyStatus: "unfinished",
      };
    },
  );
  const merged = await store.mergeInteractions(interactions);
  if (merged.status !== "ok")
    throw new Error("Legacy journal merge was not verified");
  for (const source of sourceContents) {
    const current = await api.sdk.files.read({
      hostId: environment.hostId,
      rootPath: environment.path,
      path: source.path,
    });
    if (current.sha256 !== source.sha256 || current.content !== source.content)
      continue;
    const tombstone = `<!-- lazy-chat migrated ${source.sha256} -->\n`;
    const replaced = await api.sdk.files.write({
      hostId: environment.hostId,
      rootPath: environment.path,
      path: source.path,
      content: tombstone,
      contentEncoding: "utf8",
      expectedSha256: source.sha256,
    });
    if (replaced.outcome !== "written") continue;
    const verify = await api.sdk.files.read({
      hostId: environment.hostId,
      rootPath: environment.path,
      path: source.path,
    });
    if (verify.sha256 !== replaced.sha256 || verify.content !== tombstone)
      continue;
    await api.sdk.files.remove({
      hostId: environment.hostId,
      rootPath: environment.path,
      path: source.path,
    });
  }
}

async function loadReplyDraft(api: BbPluginApi, identity: ReplyIdentity) {
  const round = await inspectOwnedRound(api, identity);
  if (!round) return { status: "invalid_round" as const };
  const store = await storeFor(api, identity.threadId);
  const observed = await persistObservedUserMessages(round, store);
  if (observed && observed.status !== "ok")
    return {
      status: "storage_error" as const,
      reason: "write_failed" as const,
    };
  const current = await store.loadCurrent();
  const isActiveRound =
    round.thread.status === "idle" &&
    round.latestMessageId === identity.messageId &&
    !round.hasNewerActivity;
  if (isActiveRound)
    await migrateLegacyRecords(api, round, identity.threadId, store);
  if (
    isActiveRound &&
    current.status === "ok" &&
    (current.value.turnId !== identity.turnId ||
      current.value.messageId !== identity.messageId)
  ) {
    const consolidated = await store.consolidateCurrent(current.sha256);
    if (consolidated.status !== "ok")
      return {
        status: "storage_error" as const,
        reason: "write_failed" as const,
      };
  } else if (current.status === "error" || current.status === "conflict") {
    return { status: "storage_error" as const, reason: "corrupt" as const };
  }
  const reloaded = await store.loadCurrent();
  if (
    reloaded.status === "ok" &&
    reloaded.value.turnId === identity.turnId &&
    reloaded.value.messageId === identity.messageId
  ) {
    if (reloaded.value.contributionBody !== round.contribution.text)
      return { status: "storage_error" as const, reason: "corrupt" as const };
    return {
      status: "loaded" as const,
      contributionBody: round.contribution.text,
      draftBody: reloaded.value.replyBody,
      draftSha256: reloaded.sha256,
    };
  }
  if (reloaded.status !== "missing" && reloaded.status !== "ok")
    return { status: "storage_error" as const, reason: "corrupt" as const };
  const journal = await store.loadJournal();
  if (journal.status === "error" || journal.status === "conflict")
    return { status: "storage_error" as const, reason: "corrupt" as const };
  const historical =
    journal.status === "ok"
      ? journal.value.interactions
          .filter(
            (item) =>
              item.turnId === identity.turnId &&
              item.messageId === identity.messageId,
          )
          .reduce(
            (latest, item) =>
              item.revision > (latest?.revision ?? 0) ? item : latest,
            undefined as ThreadInteraction | undefined,
          )
      : undefined;
  return {
    status: "loaded" as const,
    contributionBody: round.contribution.text,
    draftBody: historical?.replyBody ?? null,
    draftSha256: null,
  };
}

async function saveReplyDraft(
  api: BbPluginApi,
  input: ReplyIdentity & { body: string; expectedSha256: string | null },
) {
  const round = await inspectOwnedRound(api, input);
  if (!round) return { status: "invalid_round" as const };
  if (
    input.body.length > 1_000_000 ||
    round.contribution.text.length > 1_000_000
  )
    return { status: "storage_error" as const, reason: "corrupt" as const };
  const store = await storeFor(api, input.threadId);
  const observed = await persistObservedUserMessages(round, store);
  if (observed && observed.status !== "ok")
    return {
      status: "storage_error" as const,
      reason: "write_failed" as const,
    };
  const isActiveRound =
    round.thread.status === "idle" &&
    round.latestMessageId === input.messageId &&
    !round.hasNewerActivity;
  let existing = await store.loadCurrent();
  if (existing.status === "error")
    return { status: "storage_error" as const, reason: "corrupt" as const };
  const ownsCurrent =
    existing.status === "ok" &&
    existing.value.turnId === input.turnId &&
    existing.value.messageId === input.messageId;
  if (isActiveRound && existing.status === "ok" && !ownsCurrent) {
    const consolidated = await store.consolidateCurrent(existing.sha256);
    if (consolidated.status !== "ok")
      return {
        status: "storage_error" as const,
        reason: "write_failed" as const,
      };
    existing = await store.loadCurrent();
  }
  if (
    !isActiveRound &&
    (!ownsCurrent ||
      existing.status !== "ok" ||
      existing.sha256 !== input.expectedSha256)
  ) {
    const journal = await store.loadJournal();
    if (journal.status === "error" || journal.status === "conflict")
      return { status: "storage_error" as const, reason: "corrupt" as const };
    const journalRevision =
      journal.status === "ok"
        ? journal.value.interactions
            .filter(
              (item) =>
                item.turnId === input.turnId &&
                item.messageId === input.messageId,
            )
            .reduce((max, item) => Math.max(max, item.revision), 0)
        : 0;
    const priorRevision =
      ownsCurrent && existing.status === "ok"
        ? Math.max(journalRevision, existing.value.revision)
        : journalRevision;
    const appended = await store.mergeInteractions([
      {
        turnId: input.turnId,
        messageId: input.messageId,
        revision: priorRevision + 1,
        contributionBody: round.contribution.text,
        sourceSeqStart: round.contribution.sourceSeqStart,
        sourceSeqEnd: round.contribution.sourceSeqEnd,
        replyBody: input.body,
        replyStatus: "unfinished",
      },
    ]);
    return appended.status === "ok"
      ? { status: "saved" as const, sha256: appended.sha256 }
      : {
          status: "storage_error" as const,
          reason:
            appended.status === "conflict"
              ? ("write_failed" as const)
              : ("write_failed" as const),
        };
  }
  if (ownsCurrent && existing.status === "ok" && existing.value.consolidating)
    return {
      status: "conflict" as const,
      diskBody: existing.value.replyBody,
      diskSha256: existing.sha256,
    };
  const current = {
    turnId: input.turnId,
    messageId: input.messageId,
    contributionBody: round.contribution.text,
    sourceSeqStart: round.contribution.sourceSeqStart,
    sourceSeqEnd: round.contribution.sourceSeqEnd,
    replyBody: input.body,
    replyStatus: "unfinished" as const,
    revision: existing.status === "ok" ? existing.value.revision + 1 : 1,
  };
  const saved = await store.saveCurrent(current, input.expectedSha256);
  if (saved.status === "ok") {
    if (!isActiveRound) await store.consolidateCurrent(saved.sha256);
    return { status: "saved" as const, sha256: saved.sha256 };
  }
  if (saved.status === "conflict") {
    const disk = await store.loadCurrent();
    if (
      disk.status === "ok" &&
      disk.value.turnId === input.turnId &&
      disk.value.messageId === input.messageId
    )
      return {
        status: "conflict" as const,
        diskBody: disk.value.replyBody,
        diskSha256: disk.sha256,
      };
    return { status: "conflict" as const, diskBody: null, diskSha256: null };
  }
  return { status: "storage_error" as const, reason: "write_failed" as const };
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

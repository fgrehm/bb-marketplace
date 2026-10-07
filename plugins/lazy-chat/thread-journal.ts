import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type FilesApi = Pick<
  BbPluginApi["sdk"]["files"],
  "read" | "write" | "remove" | "list"
>;

export interface ThreadInteraction {
  turnId: string;
  messageId: string;
  revision: number;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  contributionBody: string;
  replyBody: string;
  replyStatus: "unfinished";
}

export interface ThreadUserMessage {
  messageId: string;
  turnId: string | null;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  turnRequestStatus: "pending" | "accepted" | "rejected";
  body: string;
}

export interface CurrentInteraction extends ThreadInteraction {
  consolidating?: true;
}

export interface ThreadJournal {
  threadId: string;
  interactions: ThreadInteraction[];
  userMessages: ThreadUserMessage[];
}

export type JournalResult<T> =
  | { status: "ok"; value: T; sha256: string }
  | { status: "missing" }
  | { status: "conflict" }
  | { status: "error" };

const BASE = ".lazyai/bb";
const JOURNAL = `${BASE}/conversation.md`;
const CURRENT = `${BASE}/current.md`;
const THREAD_ID = /^thr_[a-z0-9]+$/u;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function validateIdentity(threadId: string, turnId: string, messageId: string) {
  if (!THREAD_ID.test(threadId) || !RECORD_ID.test(turnId))
    throw new TypeError("Invalid thread journal identity");
  if (!messageId || messageId.length > 512)
    throw new TypeError("Invalid thread journal message id");
}

function encodeBody(label: string, body: string): string {
  return `<!-- ${label}-length: ${body.length} -->\n${body}`;
}

function takeBody(content: string, offset: number, label: string) {
  const marker = `<!-- ${label}-length: `;
  if (!content.startsWith(marker, offset))
    throw new Error("Malformed body marker");
  const end = content.indexOf(" -->\n", offset + marker.length);
  if (end < 0) throw new Error("Malformed body length");
  const lengthText = content.slice(offset + marker.length, end);
  if (!/^\d+$/u.test(lengthText)) throw new Error("Invalid body length");
  const length = Number(lengthText);
  const start = end + 5;
  const body = content.slice(start, start + length);
  if (body.length !== length) throw new Error("Truncated body");
  return { body, offset: start + length };
}

function serializeInteraction(value: ThreadInteraction): string {
  validateIdentity("thr_valid", value.turnId, value.messageId);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1)
    throw new TypeError("Invalid interaction revision");
  if (
    !Number.isSafeInteger(value.sourceSeqStart) ||
    !Number.isSafeInteger(value.sourceSeqEnd) ||
    value.sourceSeqEnd < value.sourceSeqStart
  )
    throw new TypeError("Invalid interaction source sequence");
  return [
    `## Interaction ${JSON.stringify([value.turnId, value.messageId])}`,
    `revision: ${value.revision}`,
    `sourceSeqStart: ${value.sourceSeqStart}`,
    `sourceSeqEnd: ${value.sourceSeqEnd}`,
    `replyStatus: ${value.replyStatus}`,
    "### Contribution",
    encodeBody("contribution", value.contributionBody),
    "### Reply",
    encodeBody("reply", value.replyBody),
  ].join("\n");
}

function serializeUserMessage(value: ThreadUserMessage): string {
  if (
    !value.messageId ||
    value.messageId.length > 512 ||
    !Number.isSafeInteger(value.sourceSeqStart) ||
    !Number.isSafeInteger(value.sourceSeqEnd) ||
    value.sourceSeqEnd < value.sourceSeqStart
  )
    throw new TypeError("Invalid user-message timeline identity");
  return [
    `## User message ${JSON.stringify(value.messageId)}`,
    `turnId: ${JSON.stringify(value.turnId)}`,
    `sourceSeqStart: ${value.sourceSeqStart}`,
    `sourceSeqEnd: ${value.sourceSeqEnd}`,
    `turnRequestStatus: ${value.turnRequestStatus}`,
    "### Text",
    encodeBody("message", value.body),
  ].join("\n");
}

function serializeJournal(journal: ThreadJournal): string {
  if (!THREAD_ID.test(journal.threadId))
    throw new TypeError("Invalid threadId");
  const unique = new Set<string>();
  for (const item of journal.interactions) {
    const key = JSON.stringify([item.turnId, item.messageId, item.revision]);
    if (unique.has(key)) throw new Error("Duplicate interaction identity");
    unique.add(key);
  }
  const entries = [
    ...journal.interactions.map((entry) => ({
      sequence: entry.sourceSeqStart,
      serialized: serializeInteraction(entry),
    })),
    ...journal.userMessages.map((entry) => ({
      sequence: entry.sourceSeqStart,
      serialized: serializeUserMessage(entry),
    })),
  ].sort(
    (a, b) =>
      a.sequence - b.sequence || a.serialized.localeCompare(b.serialized),
  );
  return [
    "---",
    "lazyaiVersion: 3",
    `threadId: ${journal.threadId}`,
    "kind: conversation-journal",
    "---",
    "",
    ...entries.map((entry) => entry.serialized),
    "",
  ].join("\n");
}

function parseJournal(content: string, threadId: string): ThreadJournal {
  const marker = `---\nlazyaiVersion: 3\nthreadId: ${threadId}\nkind: conversation-journal\n---\n\n`;
  if (!content.startsWith(marker))
    throw new Error("Invalid journal frontmatter");
  let offset = marker.length;
  const interactions: ThreadInteraction[] = [];
  const userMessages: ThreadUserMessage[] = [];
  while (offset < content.length) {
    if (content.slice(offset) === "\n") break;
    if (content.startsWith("## User message ", offset)) {
      const parsed = parseUserMessage(content, offset);
      userMessages.push(parsed.value);
      offset = parsed.offset;
      if (content[offset] === "\n") offset += 1;
      continue;
    }
    const headerEnd = content.indexOf("\n", offset);
    if (headerEnd < 0) throw new Error("Invalid interaction header");
    const match = /^## Interaction (.+)$/u.exec(
      content.slice(offset, headerEnd),
    );
    if (!match) throw new Error("Invalid interaction header");
    const identity = JSON.parse(match[1]!) as [string, string];
    if (!Array.isArray(identity) || identity.length !== 2)
      throw new Error("Invalid interaction identity");
    const [turnId, messageId] = identity;
    validateIdentity(threadId, turnId, messageId);
    offset = headerEnd + 1;
    const revisionEnd = content.indexOf("\n", offset);
    if (
      revisionEnd < 0 ||
      !/^revision: [1-9]\d*$/u.test(content.slice(offset, revisionEnd))
    )
      throw new Error("Invalid interaction revision");
    const revision = Number(
      content.slice(offset + "revision: ".length, revisionEnd),
    );
    offset = revisionEnd + 1;
    const sequenceStartEnd = content.indexOf("\n", offset);
    if (
      sequenceStartEnd < 0 ||
      !/^sourceSeqStart: \d+$/u.test(content.slice(offset, sequenceStartEnd))
    )
      throw new Error("Invalid interaction source sequence");
    const sourceSeqStart = Number(
      content.slice(offset + "sourceSeqStart: ".length, sequenceStartEnd),
    );
    offset = sequenceStartEnd + 1;
    const sequenceEndEnd = content.indexOf("\n", offset);
    if (
      sequenceEndEnd < 0 ||
      !/^sourceSeqEnd: \d+$/u.test(content.slice(offset, sequenceEndEnd))
    )
      throw new Error("Invalid interaction source sequence");
    const sourceSeqEnd = Number(
      content.slice(offset + "sourceSeqEnd: ".length, sequenceEndEnd),
    );
    offset = sequenceEndEnd + 1;
    const statusEnd = content.indexOf("\n", offset);
    if (
      statusEnd < 0 ||
      content.slice(offset, statusEnd) !== "replyStatus: unfinished"
    )
      throw new Error("Invalid reply status");
    offset = statusEnd + 1;
    const contributionHeader = "### Contribution\n";
    if (!content.startsWith(contributionHeader, offset))
      throw new Error("Missing contribution section");
    offset += contributionHeader.length;
    const contribution = takeBody(content, offset, "contribution");
    offset = contribution.offset;
    if (content[offset] !== "\n")
      throw new Error("Invalid contribution boundary");
    offset += 1;
    const replyHeader = "### Reply\n";
    if (!content.startsWith(replyHeader, offset))
      throw new Error("Missing reply section");
    offset += replyHeader.length;
    const reply = takeBody(content, offset, "reply");
    offset = reply.offset;
    interactions.push({
      turnId,
      messageId,
      revision,
      sourceSeqStart,
      sourceSeqEnd,
      contributionBody: contribution.body,
      replyBody: reply.body,
      replyStatus: "unfinished",
    });
    if (content[offset] === "\n") offset += 1;
  }
  return { threadId, interactions, userMessages };
}

function parseUserMessage(
  content: string,
  offset: number,
): { value: ThreadUserMessage; offset: number } {
  const headerEnd = content.indexOf("\n", offset);
  if (headerEnd < 0) throw new Error("Invalid user-message header");
  const messageId = JSON.parse(
    content.slice(offset + "## User message ".length, headerEnd),
  ) as string;
  let cursor = headerEnd + 1;
  const takeField = (prefix: string) => {
    const end = content.indexOf("\n", cursor);
    if (end < 0 || !content.startsWith(prefix, cursor))
      throw new Error("Invalid user-message metadata");
    const value = content.slice(cursor + prefix.length, end);
    cursor = end + 1;
    return value;
  };
  const turnId = JSON.parse(takeField("turnId: ")) as string | null;
  const sourceSeqStart = Number(takeField("sourceSeqStart: "));
  const sourceSeqEnd = Number(takeField("sourceSeqEnd: "));
  const turnRequestStatus = takeField("turnRequestStatus: ");
  if (
    !Number.isSafeInteger(sourceSeqStart) ||
    !Number.isSafeInteger(sourceSeqEnd) ||
    sourceSeqEnd < sourceSeqStart ||
    !["pending", "accepted", "rejected"].includes(turnRequestStatus)
  )
    throw new Error("Invalid user-message metadata");
  if (!content.startsWith("### Text\n", cursor))
    throw new Error("Missing user-message body");
  cursor += "### Text\n".length;
  const body = takeBody(content, cursor, "message");
  return {
    value: {
      messageId,
      turnId,
      sourceSeqStart,
      sourceSeqEnd,
      turnRequestStatus:
        turnRequestStatus as ThreadUserMessage["turnRequestStatus"],
      body: body.body,
    },
    offset: body.offset,
  };
}

function serializeCurrent(
  current: CurrentInteraction,
  threadId: string,
): string {
  validateIdentity(threadId, current.turnId, current.messageId);
  return [
    "---",
    "lazyaiVersion: 3",
    `threadId: ${threadId}`,
    `turnId: ${current.turnId}`,
    `messageId: ${JSON.stringify(current.messageId)}`,
    `revision: ${current.revision}`,
    `sourceSeqStart: ${current.sourceSeqStart}`,
    `sourceSeqEnd: ${current.sourceSeqEnd}`,
    `kind: ${current.consolidating ? "consolidating-interaction" : "current-interaction"}`,
    "replyStatus: unfinished",
    "---",
    "",
    "## Contribution",
    encodeBody("contribution", current.contributionBody),
    "## Reply",
    encodeBody("reply", current.replyBody),
    "",
  ].join("\n");
}

function parseCurrent(content: string, threadId: string): CurrentInteraction {
  const headerEnd = content.indexOf("\n---\n");
  if (!content.startsWith("---\n") || headerEnd < 0)
    throw new Error("Invalid current frontmatter");
  const values = new Map<string, string>();
  for (const line of content.slice(4, headerEnd).split("\n")) {
    const separator = line.indexOf(": ");
    if (separator < 1 || values.has(line.slice(0, separator)))
      throw new Error("Invalid current metadata");
    values.set(line.slice(0, separator), line.slice(separator + 2));
  }
  const turnId = values.get("turnId") ?? "";
  const messageId = JSON.parse(values.get("messageId") ?? "null") as string;
  validateIdentity(threadId, turnId, messageId);
  const revision = Number(values.get("revision"));
  const sourceSeqStart = Number(values.get("sourceSeqStart"));
  const sourceSeqEnd = Number(values.get("sourceSeqEnd"));
  const consolidating = values.get("kind") === "consolidating-interaction";
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(sourceSeqStart) ||
    !Number.isSafeInteger(sourceSeqEnd) ||
    sourceSeqEnd < sourceSeqStart ||
    values.get("lazyaiVersion") !== "3" ||
    values.get("threadId") !== threadId ||
    (!consolidating && values.get("kind") !== "current-interaction") ||
    values.get("replyStatus") !== "unfinished"
  )
    throw new Error("Invalid current metadata");
  let offset = headerEnd + 6;
  const contributionHeader = "## Contribution\n";
  if (!content.startsWith(contributionHeader, offset))
    throw new Error("Missing current contribution");
  offset += contributionHeader.length;
  const contribution = takeBody(content, offset, "contribution");
  offset = contribution.offset + 1;
  if (!content.startsWith("## Reply\n", offset))
    throw new Error("Missing current reply");
  offset += "## Reply\n".length;
  const reply = takeBody(content, offset, "reply");
  if (content.slice(reply.offset) !== "\n")
    throw new Error("Unexpected current trailing content");
  return {
    turnId,
    messageId,
    revision,
    sourceSeqStart,
    sourceSeqEnd,
    ...(consolidating ? { consolidating: true as const } : {}),
    contributionBody: contribution.body,
    replyBody: reply.body,
    replyStatus: "unfinished",
  };
}

export function createThreadJournalStore(
  files: FilesApi,
  location: { hostId: string; storageRootPath: string },
  threadId: string,
) {
  if (
    !location.hostId ||
    !location.storageRootPath ||
    !THREAD_ID.test(threadId)
  )
    throw new TypeError("Invalid thread storage location");
  const fileArgs = {
    hostId: location.hostId,
    rootPath: location.storageRootPath,
  };
  async function read(path: string) {
    try {
      const response = await files.read({ ...fileArgs, path });
      if (
        response.contentEncoding !== "utf8" ||
        digest(response.content) !== response.sha256
      )
        return { status: "error" as const };
      return {
        status: "ok" as const,
        content: response.content,
        sha256: response.sha256,
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      )
        return { status: "missing" as const };
      return { status: "error" as const };
    }
  }
  async function write(
    path: string,
    content: string,
    expectedSha256: string | null,
  ) {
    const response = await files.write({
      ...fileArgs,
      path,
      content,
      contentEncoding: "utf8",
      createParents: true,
      expectedSha256,
    });
    return response.outcome === "written"
      ? { status: "ok" as const, sha256: response.sha256 }
      : { status: "conflict" as const };
  }
  async function loadJournal(): Promise<JournalResult<ThreadJournal>> {
    const result = await read(JOURNAL);
    if (result.status !== "ok") return result;
    try {
      return {
        status: "ok",
        value: parseJournal(result.content, threadId),
        sha256: result.sha256,
      };
    } catch {
      return { status: "error" };
    }
  }
  async function loadCurrent(): Promise<JournalResult<CurrentInteraction>> {
    const result = await read(CURRENT);
    if (result.status !== "ok") return result;
    try {
      return {
        status: "ok",
        value: parseCurrent(result.content, threadId),
        sha256: result.sha256,
      };
    } catch {
      return { status: "error" };
    }
  }
  async function saveCurrent(
    current: CurrentInteraction,
    expectedSha256: string | null,
  ): Promise<JournalResult<CurrentInteraction>> {
    const existing = await loadCurrent();
    if (expectedSha256 === null && existing.status !== "missing")
      return { status: "conflict" };
    if (
      expectedSha256 !== null &&
      (existing.status !== "ok" ||
        existing.sha256 !== expectedSha256 ||
        existing.value.consolidating)
    )
      return { status: "conflict" };
    const content = serializeCurrent(current, threadId);
    const saved = await write(CURRENT, content, expectedSha256);
    return saved.status === "ok"
      ? { status: "ok", value: current, sha256: saved.sha256 }
      : saved;
  }
  async function consolidateCurrent(
    expectedSha256: string,
  ): Promise<JournalResult<ThreadJournal>> {
    if (!HASH.test(expectedSha256)) return { status: "error" };
    const current = await loadCurrent();
    if (current.status !== "ok" || current.sha256 !== expectedSha256)
      return { status: "conflict" };
    for (let attempt = 0; attempt < 4; attempt++) {
      const journal = await loadJournal();
      if (journal.status !== "ok" && journal.status !== "missing")
        return { status: "error" };
      const existing =
        journal.status === "ok"
          ? journal.value
          : { threadId, interactions: [], userMessages: [] };
      const item = current.value;
      const key = (entry: ThreadInteraction) =>
        JSON.stringify([entry.turnId, entry.messageId, entry.revision]);
      const old = existing.interactions.find(
        (entry) => key(entry) === key(item),
      );
      if (
        old &&
        (old.contributionBody !== item.contributionBody ||
          old.replyBody !== item.replyBody)
      )
        return { status: "conflict" };
      const next: ThreadJournal = old
        ? existing
        : { ...existing, interactions: [...existing.interactions, item] };
      const serialized = serializeJournal(next);
      let written: { status: "ok"; sha256: string } | { status: "conflict" };
      if (journal.status === "missing")
        written = await write(JOURNAL, serialized, null);
      else written = await write(JOURNAL, serialized, journal.sha256);
      if (written.status === "conflict") continue;
      const verified = await loadJournal();
      if (
        verified.status !== "ok" ||
        !verified.value.interactions.some(
          (entry) =>
            key(entry) === key(item) &&
            entry.contributionBody === item.contributionBody &&
            entry.replyBody === item.replyBody,
        )
      )
        return { status: "error" };
      // The files API has no conditional remove. First CAS current to a revision-bound tombstone so stale writers cannot overwrite it.
      const tombstone = serializeCurrent(
        { ...item, consolidating: true },
        threadId,
      );
      let tombstoneSha256 = current.sha256;
      if (!current.value.consolidating) {
        const tombstoneWrite = await write(CURRENT, tombstone, current.sha256);
        if (tombstoneWrite.status !== "ok") return { status: "conflict" };
        tombstoneSha256 = tombstoneWrite.sha256;
      }
      const reread = await read(CURRENT);
      if (
        reread.status !== "ok" ||
        reread.sha256 !== tombstoneSha256 ||
        reread.content !== tombstone
      )
        return { status: "error" };
      const removed = await files.remove({ ...fileArgs, path: CURRENT });
      if (!removed.ok) return { status: "error" };
      return verified;
    }
    return { status: "conflict" };
  }
  async function mergeInteractions(
    interactions: ThreadInteraction[],
  ): Promise<JournalResult<ThreadJournal>> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const journal = await loadJournal();
      if (journal.status !== "ok" && journal.status !== "missing")
        return { status: "error" };
      const existing =
        journal.status === "ok"
          ? journal.value
          : { threadId, interactions: [], userMessages: [] };
      const nextInteractions = [...existing.interactions];
      for (const candidate of interactions) {
        const old = nextInteractions.find(
          (entry) =>
            entry.turnId === candidate.turnId &&
            entry.messageId === candidate.messageId &&
            entry.revision === candidate.revision,
        );
        if (
          old &&
          (old.contributionBody !== candidate.contributionBody ||
            old.replyBody !== candidate.replyBody)
        )
          return { status: "conflict" };
        if (!old) nextInteractions.push(candidate);
      }
      const next = {
        threadId,
        interactions: nextInteractions,
        userMessages: existing.userMessages,
      };
      const content = serializeJournal(next);
      const written = await write(
        JOURNAL,
        content,
        journal.status === "ok" ? journal.sha256 : null,
      );
      if (written.status === "conflict") continue;
      const verified = await loadJournal();
      if (verified.status !== "ok") return { status: "error" };
      for (const candidate of interactions) {
        if (
          !verified.value.interactions.some(
            (entry) =>
              entry.turnId === candidate.turnId &&
              entry.messageId === candidate.messageId &&
              entry.contributionBody === candidate.contributionBody &&
              entry.replyBody === candidate.replyBody,
          )
        )
          return { status: "error" };
      }
      return verified;
    }
    return { status: "conflict" };
  }
  async function mergeUserMessages(
    messages: ThreadUserMessage[],
  ): Promise<JournalResult<ThreadJournal>> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const journal = await loadJournal();
      if (journal.status !== "ok" && journal.status !== "missing")
        return { status: "error" };
      const existing =
        journal.status === "ok"
          ? journal.value
          : { threadId, interactions: [], userMessages: [] };
      const nextMessages = [...existing.userMessages];
      for (const candidate of messages) {
        const old = nextMessages.find(
          (entry) => entry.messageId === candidate.messageId,
        );
        if (
          old &&
          (old.turnId !== candidate.turnId ||
            old.sourceSeqStart !== candidate.sourceSeqStart ||
            old.sourceSeqEnd !== candidate.sourceSeqEnd ||
            old.body !== candidate.body)
        )
          return { status: "conflict" };
        if (!old) {
          nextMessages.push(candidate);
        } else if (old.turnRequestStatus !== candidate.turnRequestStatus) {
          if (old.turnRequestStatus !== "pending")
            return { status: "conflict" };
          nextMessages[nextMessages.indexOf(old)] = candidate;
        }
      }
      const next = {
        threadId,
        interactions: existing.interactions,
        userMessages: nextMessages,
      };
      const written = await write(
        JOURNAL,
        serializeJournal(next),
        journal.status === "ok" ? journal.sha256 : null,
      );
      if (written.status === "conflict") continue;
      const verified = await loadJournal();
      if (verified.status !== "ok") return { status: "error" };
      if (
        messages.some(
          (candidate) =>
            !verified.value.userMessages.some(
              (entry) =>
                entry.messageId === candidate.messageId &&
                entry.body === candidate.body &&
                entry.sourceSeqStart === candidate.sourceSeqStart &&
                entry.sourceSeqEnd === candidate.sourceSeqEnd &&
                entry.turnRequestStatus === candidate.turnRequestStatus,
            ),
        )
      )
        return { status: "error" };
      return verified;
    }
    return { status: "conflict" };
  }
  return {
    loadJournal,
    loadCurrent,
    saveCurrent,
    consolidateCurrent,
    mergeInteractions,
    mergeUserMessages,
  };
}

export const threadJournalPaths = {
  journal: JOURNAL,
  current: CURRENT,
} as const;

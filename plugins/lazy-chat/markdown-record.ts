export type RecordAttribution = "agent" | "human";
export type DraftStatus = "immutable" | "active" | "submitted";

interface RecordIdentity {
  threadId: string;
  turnId: string;
  messageId: string;
}

export interface ContributionRecord extends RecordIdentity {
  version: 1;
  kind: "contribution";
  attribution: "agent";
  draftStatus: "immutable";
  body: string;
}

export interface DraftRecord extends RecordIdentity {
  version: 1;
  kind: "draft";
  attribution: RecordAttribution;
  draftStatus: "active" | "submitted";
  body: string;
}

export type MarkdownRecord = ContributionRecord | DraftRecord;

const HEADER_KEYS = [
  "lazyaiVersion",
  "kind",
  "threadId",
  "turnId",
  "messageId",
  "attribution",
  "draftStatus",
] as const;
const THREAD_ID = /^thr_[a-z0-9]+$/u;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export class MalformedMarkdownRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedMarkdownRecordError";
  }
}

export class UnsupportedMarkdownRecordVersionError extends Error {
  constructor(version: string) {
    super(`Unsupported Lazy Chat Markdown version: ${version}`);
    this.name = "UnsupportedMarkdownRecordVersionError";
  }
}

function validateRecord(record: MarkdownRecord): void {
  if (record.version !== 1) {
    throw new UnsupportedMarkdownRecordVersionError(String(record.version));
  }
  if (!THREAD_ID.test(record.threadId))
    throw new MalformedMarkdownRecordError("Invalid threadId");
  if (!RECORD_ID.test(record.turnId))
    throw new MalformedMarkdownRecordError("Invalid turnId");
  if (
    typeof record.messageId !== "string" ||
    record.messageId.length === 0 ||
    record.messageId.length > 512
  )
    throw new MalformedMarkdownRecordError("Invalid messageId");
  if (typeof record.body !== "string")
    throw new MalformedMarkdownRecordError("Markdown body must be a string");
  if (record.kind === "contribution") {
    if (record.attribution !== "agent" || record.draftStatus !== "immutable")
      throw new MalformedMarkdownRecordError(
        "Contribution attribution/status is invalid",
      );
    return;
  }
  if (
    record.kind !== "draft" ||
    (record.attribution !== "agent" && record.attribution !== "human") ||
    (record.draftStatus !== "active" && record.draftStatus !== "submitted")
  ) {
    throw new MalformedMarkdownRecordError(
      "Draft attribution/status is invalid",
    );
  }
}

export function serializeMarkdownRecord(record: MarkdownRecord): string {
  validateRecord(record);
  const header = [
    "---",
    "lazyaiVersion: 1",
    `kind: ${record.kind}`,
    `threadId: ${record.threadId}`,
    `turnId: ${record.turnId}`,
    `messageId: ${JSON.stringify(record.messageId)}`,
    `attribution: ${record.attribution}`,
    `draftStatus: ${record.draftStatus}`,
    "---",
    "",
  ].join("\n");
  return `${header}${record.body}`;
}

export function parseMarkdownRecord(content: string): MarkdownRecord {
  if (!content.startsWith("---\n"))
    throw new MalformedMarkdownRecordError("Missing frontmatter start");
  const end = content.indexOf("\n---\n", 4);
  if (end < 0)
    throw new MalformedMarkdownRecordError("Missing frontmatter end");
  const lines = content.slice(4, end).split("\n");
  if (lines.length !== HEADER_KEYS.length)
    throw new MalformedMarkdownRecordError(
      "Unexpected frontmatter field count",
    );
  const values = new Map<string, string>();
  lines.forEach((line, index) => {
    const separator = line.indexOf(": ");
    if (separator <= 0)
      throw new MalformedMarkdownRecordError("Malformed frontmatter field");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 2);
    if (key !== HEADER_KEYS[index] || values.has(key))
      throw new MalformedMarkdownRecordError(
        "Unknown, duplicate, or reordered field",
      );
    values.set(key, value);
  });
  const version = values.get("lazyaiVersion");
  if (version !== "1")
    throw new UnsupportedMarkdownRecordVersionError(version ?? "missing");
  const kind = values.get("kind");
  const threadId = values.get("threadId");
  const turnId = values.get("turnId");
  const encodedMessageId = values.get("messageId");
  let messageId: unknown;
  try {
    messageId = JSON.parse(encodedMessageId ?? "");
  } catch {
    throw new MalformedMarkdownRecordError("messageId must be a JSON string");
  }
  if (typeof messageId !== "string")
    throw new MalformedMarkdownRecordError("messageId must be a JSON string");
  const attribution = values.get("attribution");
  const draftStatus = values.get("draftStatus");
  const body = content.slice(end + "\n---\n".length);
  const record = {
    version: 1 as const,
    kind,
    threadId,
    turnId,
    messageId,
    attribution,
    draftStatus,
    body,
  };
  if (
    kind === "contribution" &&
    threadId !== undefined &&
    turnId !== undefined &&
    messageId !== undefined &&
    attribution === "agent" &&
    draftStatus === "immutable"
  ) {
    const contribution: ContributionRecord = {
      ...record,
      kind,
      threadId,
      turnId,
      messageId,
      attribution,
      draftStatus,
    };
    validateRecord(contribution);
    return contribution;
  }
  if (
    kind === "draft" &&
    threadId !== undefined &&
    turnId !== undefined &&
    messageId !== undefined &&
    (attribution === "agent" || attribution === "human") &&
    (draftStatus === "active" || draftStatus === "submitted")
  ) {
    const draft: DraftRecord = {
      ...record,
      kind,
      threadId,
      turnId,
      messageId,
      attribution,
      draftStatus,
    };
    validateRecord(draft);
    return draft;
  }
  throw new MalformedMarkdownRecordError("Invalid record fields");
}

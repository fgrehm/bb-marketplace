import { createHash } from "node:crypto";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  parseMarkdownRecord,
  serializeMarkdownRecord,
  type ContributionRecord,
  type DraftRecord,
  type MarkdownRecord,
} from "./markdown-record";

type FilesApi = Pick<BbPluginApi["sdk"]["files"], "read" | "write">;

export interface ResolvedWorkspaceLocation {
  hostId: string;
  rootPath: string;
}

export type RecordLoadResult<T extends MarkdownRecord> =
  | { status: "loaded"; record: T; sha256: string }
  | { status: "missing" }
  | { status: "identity_mismatch" }
  | { status: "malformed"; error: Error }
  | { status: "io_error"; error: unknown };

export type RecordSaveResult =
  | { status: "created" | "updated" | "reused"; sha256: string }
  | { status: "missing" }
  | { status: "conflict"; currentSha256: string | null }
  | { status: "identity_mismatch" }
  | { status: "malformed"; error: Error }
  | { status: "io_error"; error: unknown };

interface RecordIdentity {
  threadId: string;
  turnId: string;
  messageId: string;
}

interface StoragePaths {
  rootPath: string;
  contributionPath: string;
  draftPath: string;
}

const THREAD_ID = /^thr_[a-z0-9]+$/u;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.status !== 404) return false;
  if (error.code === "ENOENT") return true;
  return isRecord(error.body) && error.body.code === "ENOENT";
}

function pathsFor(
  location: ResolvedWorkspaceLocation,
  identity: RecordIdentity,
): StoragePaths {
  if (typeof location.hostId !== "string" || location.hostId.length === 0)
    throw new TypeError("Resolved storage location requires a hostId");
  if (typeof location.rootPath !== "string" || location.rootPath.includes("\0"))
    throw new TypeError("Resolved storage location requires a valid rootPath");
  if (!THREAD_ID.test(identity.threadId))
    throw new TypeError("Unsafe threadId storage path component");
  if (!RECORD_ID.test(identity.turnId))
    throw new TypeError("Unsafe turnId storage path component");
  if (
    typeof identity.messageId !== "string" ||
    identity.messageId.length === 0 ||
    identity.messageId.length > 512
  )
    throw new TypeError("Invalid messageId");

  const pathApi =
    /^[A-Za-z]:[\\/]/u.test(location.rootPath) ||
    location.rootPath.startsWith("\\\\")
      ? path.win32
      : path.posix;
  if (!pathApi.isAbsolute(location.rootPath))
    throw new TypeError("Resolved rootPath must be absolute");
  const rootPath = pathApi.normalize(location.rootPath);
  const roundPath = pathApi.join(
    rootPath,
    ".lazyai",
    "bb",
    identity.threadId,
    identity.turnId,
  );
  const contributionPath = pathApi.join(roundPath, "contribution.md");
  const draftPath = pathApi.join(roundPath, "draft.md");
  for (const candidate of [roundPath, contributionPath, draftPath]) {
    const relative = pathApi.relative(rootPath, candidate);
    if (
      relative === ".." ||
      relative.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(relative)
    )
      throw new TypeError("Storage path escapes its resolved rootPath");
  }
  return { rootPath, contributionPath, draftPath };
}

function sameRecord(left: MarkdownRecord, right: MarkdownRecord): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.messageId === right.messageId &&
    left.attribution === right.attribution &&
    left.draftStatus === right.draftStatus &&
    left.body === right.body
  );
}

export function createMarkdownStore(
  files: FilesApi,
  location: ResolvedWorkspaceLocation,
) {
  async function readRecord<T extends MarkdownRecord>(
    identity: RecordIdentity,
    kind: T["kind"],
    filePath: string,
  ): Promise<RecordLoadResult<T>> {
    const paths = pathsFor(location, identity);
    try {
      const result = await files.read({
        hostId: location.hostId,
        rootPath: paths.rootPath,
        path: filePath,
      });
      if (result.contentEncoding !== "utf8")
        return {
          status: "malformed",
          error: new Error("Stored Markdown record is not UTF-8"),
        };
      if (hash(result.content) !== result.sha256)
        return {
          status: "malformed",
          error: new Error(
            "Stored Markdown record SHA-256 does not match content",
          ),
        };
      let record: MarkdownRecord;
      try {
        record = parseMarkdownRecord(result.content);
      } catch (error) {
        return {
          status: "malformed",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      if (
        record.kind !== kind ||
        record.threadId !== identity.threadId ||
        record.turnId !== identity.turnId ||
        record.messageId !== identity.messageId
      )
        return { status: "identity_mismatch" };
      return { status: "loaded", record: record as T, sha256: result.sha256 };
    } catch (error) {
      if (isMissingFileError(error)) return { status: "missing" };
      return { status: "io_error", error };
    }
  }

  async function createOnly<T extends MarkdownRecord>(
    record: T,
    filePath: string,
  ): Promise<RecordSaveResult> {
    const paths = pathsFor(location, record);
    const existing = await readRecord<T>(record, record.kind, filePath);
    if (existing.status === "loaded") {
      return sameRecord(existing.record, record)
        ? { status: "reused", sha256: existing.sha256 }
        : { status: "conflict", currentSha256: existing.sha256 };
    }
    if (existing.status !== "missing") return existing;

    const content = serializeMarkdownRecord(record);
    try {
      const result = await files.write({
        hostId: location.hostId,
        rootPath: paths.rootPath,
        path: filePath,
        content,
        contentEncoding: "utf8",
        createParents: true,
        expectedSha256: null,
      });
      if (result.outcome === "written")
        return { status: "created", sha256: result.sha256 };
      const current = await readRecord<T>(record, record.kind, filePath);
      if (current.status === "loaded" && sameRecord(current.record, record))
        return { status: "reused", sha256: current.sha256 };
      if (current.status === "loaded")
        return { status: "conflict", currentSha256: current.sha256 };
      if (current.status === "missing")
        return { status: "conflict", currentSha256: result.currentSha256 };
      return current;
    } catch (error) {
      return { status: "io_error", error };
    }
  }

  return {
    loadContribution(
      identity: RecordIdentity,
    ): Promise<RecordLoadResult<ContributionRecord>> {
      return readRecord<ContributionRecord>(
        identity,
        "contribution",
        pathsFor(location, identity).contributionPath,
      );
    },
    saveContribution(record: ContributionRecord): Promise<RecordSaveResult> {
      const filePath = pathsFor(location, record).contributionPath;
      return createOnly(record, filePath);
    },
    loadDraft(
      identity: RecordIdentity,
    ): Promise<RecordLoadResult<DraftRecord>> {
      return readRecord<DraftRecord>(
        identity,
        "draft",
        pathsFor(location, identity).draftPath,
      );
    },
    createDraft(record: DraftRecord): Promise<RecordSaveResult> {
      const filePath = pathsFor(location, record).draftPath;
      return createOnly(record, filePath);
    },
    async updateDraft(
      record: DraftRecord,
      expectedSha256: string,
    ): Promise<RecordSaveResult> {
      if (!SHA256.test(expectedSha256))
        throw new TypeError(
          "expectedSha256 must be a lowercase SHA-256 digest",
        );
      const paths = pathsFor(location, record);
      const current = await readRecord<DraftRecord>(
        record,
        "draft",
        paths.draftPath,
      );
      if (current.status !== "loaded") return current;
      if (current.sha256 !== expectedSha256)
        return { status: "conflict", currentSha256: current.sha256 };
      try {
        const result = await files.write({
          hostId: location.hostId,
          rootPath: paths.rootPath,
          path: paths.draftPath,
          content: serializeMarkdownRecord(record),
          contentEncoding: "utf8",
          createParents: true,
          expectedSha256,
        });
        return result.outcome === "written"
          ? { status: "updated", sha256: result.sha256 }
          : { status: "conflict", currentSha256: result.currentSha256 };
      } catch (error) {
        return { status: "io_error", error };
      }
    },
  };
}

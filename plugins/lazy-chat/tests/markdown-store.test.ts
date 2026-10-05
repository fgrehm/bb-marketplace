import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeSdk } from "@get-bb/plugin-sdk/testing";
import { createMarkdownStore } from "../markdown-store";
import {
  parseMarkdownRecord,
  serializeMarkdownRecord,
  UnsupportedMarkdownRecordVersionError,
} from "../markdown-record";

const location = { hostId: "host-1", rootPath: "/workspace/project" };
const identity = {
  threadId: "thr_abc123",
  turnId: "turn-1",
  messageId: "thr_abc123:assistant:item-1",
};

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function makeFilesSdk() {
  const entries = new Map<string, string>();
  let beforeNextWrite: ((path: string) => void) | undefined;
  let nextReadError: unknown;
  const { sdk, harness } = createFakeSdk({
    pluginId: "lazy-chat",
    overrides: {
      files: {
        read: async ({ path }) => {
          if (nextReadError !== undefined) {
            const error = nextReadError;
            nextReadError = undefined;
            throw error;
          }
          const content = entries.get(path);
          if (content === undefined) {
            throw Object.assign(new Error("Path does not exist"), {
              code: "ENOENT",
              status: 404,
            });
          }
          return {
            path,
            content,
            contentEncoding: "utf8",
            sizeBytes: Buffer.byteLength(content),
            sha256: sha256(content),
          };
        },
        write: async ({ path, content, expectedSha256 }) => {
          beforeNextWrite?.(path);
          beforeNextWrite = undefined;
          const existing = entries.get(path);
          const currentSha256 =
            existing === undefined ? null : sha256(existing);
          if (expectedSha256 !== undefined && expectedSha256 !== currentSha256)
            return { outcome: "conflict", currentSha256 };
          entries.set(path, content);
          return {
            outcome: "written",
            sha256: sha256(content),
            sizeBytes: Buffer.byteLength(content),
          };
        },
      },
    },
  });
  return {
    files: sdk.files,
    harness,
    entries,
    beforeNextWrite(hook: (path: string) => void) {
      beforeNextWrite = hook;
    },
    failNextRead(error: unknown) {
      nextReadError = error;
    },
  };
}

const contribution = {
  version: 1 as const,
  kind: "contribution" as const,
  ...identity,
  attribution: "agent" as const,
  draftStatus: "immutable" as const,
  body: "# Original contribution\n",
};
const draft = {
  version: 1 as const,
  kind: "draft" as const,
  ...identity,
  attribution: "human" as const,
  draftStatus: "active" as const,
  body: "Draft body\n",
};

describe("Lazy Chat Markdown store", () => {
  it("saves then loads contribution and draft through a fresh store instance", async () => {
    const { files } = makeFilesSdk();
    const writer = createMarkdownStore(files, location);
    expect(await writer.saveContribution(contribution)).toMatchObject({
      status: "created",
    });
    expect(await writer.saveContribution(contribution)).toMatchObject({
      status: "reused",
    });
    expect(await writer.createDraft(draft)).toMatchObject({
      status: "created",
    });

    const reader = createMarkdownStore(files, location);
    expect(await reader.loadContribution(identity)).toMatchObject({
      status: "loaded",
      record: contribution,
    });
    expect(await reader.loadDraft(identity)).toMatchObject({
      status: "loaded",
      record: draft,
    });
  });

  it("round-trips punctuation and escaped messageId strings exactly", () => {
    const messageId = 'thr_abc123:assistant:item-1 with "quote"\\and\nnewline';
    const record = { ...draft, messageId };
    const serialized = serializeMarkdownRecord(record);
    expect(serialized).toContain(`messageId: ${JSON.stringify(messageId)}\n`);
    expect(parseMarkdownRecord(serialized)).toEqual(record);
  });

  it("preserves Markdown body text verbatim", () => {
    const body =
      "\n---\nlazyaiVersion: 99\nkind: draft\n---\n\n💾 café\n```md\n---\n```\n";
    const record = { ...draft, body };
    expect(parseMarkdownRecord(serializeMarkdownRecord(record))).toEqual(
      record,
    );
  });

  it("never overwrites a different existing contribution", async () => {
    const { files } = makeFilesSdk();
    const store = createMarkdownStore(files, location);
    expect(await store.saveContribution(contribution)).toMatchObject({
      status: "created",
    });
    const different = { ...contribution, body: "changed agent text" };
    expect(await store.saveContribution(different)).toMatchObject({
      status: "conflict",
    });
    expect(await store.loadContribution(identity)).toMatchObject({
      status: "loaded",
      record: contribution,
    });
  });

  it("rejects a stale two-client draft hash after an external CAS race", async () => {
    const remote = makeFilesSdk();
    const writer = createMarkdownStore(remote.files, location);
    const secondClient = createMarkdownStore(remote.files, location);
    expect(await writer.createDraft(draft)).toMatchObject({
      status: "created",
    });
    const firstRead = await writer.loadDraft(identity);
    const secondRead = await secondClient.loadDraft(identity);
    expect(firstRead.status).toBe("loaded");
    expect(secondRead.status).toBe("loaded");
    if (firstRead.status !== "loaded" || secondRead.status !== "loaded")
      throw new Error("test setup did not load initial draft");

    const firstUpdate = { ...draft, body: "client one" };
    expect(
      await writer.updateDraft(firstUpdate, firstRead.sha256),
    ).toMatchObject({
      status: "updated",
    });
    const staleUpdate = await secondClient.updateDraft(
      { ...draft, body: "client two" },
      secondRead.sha256,
    );
    expect(staleUpdate).toMatchObject({ status: "conflict" });

    const fresh = await secondClient.loadDraft(identity);
    expect(fresh.status).toBe("loaded");
    if (fresh.status !== "loaded") throw new Error("draft disappeared");
    const external = { ...draft, body: "external edit" };
    remote.beforeNextWrite((filePath) => {
      remote.entries.set(filePath, serializeMarkdownRecord(external));
    });
    const racingUpdate = await secondClient.updateDraft(
      { ...draft, body: "racing client" },
      fresh.sha256,
    );
    expect(racingUpdate).toMatchObject({ status: "conflict" });
    expect(await secondClient.loadDraft(identity)).toMatchObject({
      status: "loaded",
      record: external,
    });
  });

  it("distinguishes missing, wrong identity, and malformed versions", async () => {
    const remote = makeFilesSdk();
    const store = createMarkdownStore(remote.files, location);
    expect(await store.loadDraft(identity)).toEqual({ status: "missing" });
    const draftPath =
      "/workspace/project/.lazyai/bb/thr_abc123/turn-1/draft.md";
    remote.entries.set(
      draftPath,
      serializeMarkdownRecord({ ...draft, messageId: "msg-other" }),
    );
    expect(await store.loadDraft(identity)).toEqual({
      status: "identity_mismatch",
    });
    remote.entries.set(
      draftPath,
      serializeMarkdownRecord(draft).replace(
        "lazyaiVersion: 1",
        "lazyaiVersion: 2",
      ),
    );
    const malformed = await store.loadDraft(identity);
    expect(malformed.status).toBe("malformed");
    if (malformed.status === "malformed")
      expect(malformed.error).toBeInstanceOf(
        UnsupportedMarkdownRecordVersionError,
      );
  });

  it("reports host I/O failures separately from missing or malformed records", async () => {
    const remote = makeFilesSdk();
    const store = createMarkdownStore(remote.files, location);
    remote.failNextRead(new Error("host unavailable"));
    const result = await store.loadDraft(identity);
    expect(result.status).toBe("io_error");
    if (result.status === "io_error")
      expect(result.error).toMatchObject({ message: "host unavailable" });
  });

  it("rejects path-traversal identifiers before calling host files", async () => {
    const remote = makeFilesSdk();
    const store = createMarkdownStore(remote.files, location);
    expect(() => store.loadDraft({ ...identity, turnId: "../escape" })).toThrow(
      /Unsafe turnId/,
    );
    expect(remote.harness.callsTo("files.read")).toHaveLength(0);
  });
});

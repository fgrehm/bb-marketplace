import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

function parseToolResult(result: any) {
  return JSON.parse(
    typeof result === "string"
      ? result
      : result.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(""),
  );
}

function seedReview(
  bb: Awaited<ReturnType<typeof createFakePluginHost>>["bb"],
  options: { id: string; threadId: string; createdAt: number; path?: string },
) {
  const db = bb.storage.database();
  db.prepare(
    "INSERT INTO review_revisions (id, thread_id, snapshot, created_at) VALUES (?, ?, ?, ?)",
  ).run(
    options.id,
    options.threadId,
    `snapshot-${options.id}`,
    options.createdAt,
  );
  db.prepare(
    "INSERT INTO review_files (review_id, path, previous_path, status, additions, deletions, binary, patch, truncated) VALUES (?, ?, NULL, 'M', 1, 0, 0, '', 0)",
  ).run(options.id, options.path ?? "src/example.ts");
  return db;
}

describe("Review Workspace server", () => {
  it("registers the RPC contract without agent tools", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });

    await plugin(bb);

    expect(Object.keys(harness.registrations)).toEqual(
      expect.arrayContaining(["rpcMethods", "agentTools"]),
    );
    expect(
      harness.registrations.agentTools.map((tool: any) => tool.name),
    ).toEqual([
      "review_workspace_refresh",
      "review_workspace_status",
      "review_workspace_comment",
      "review_workspace_resolve",
      "review_workspace_history",
      "review_workspace_import",
      "review_workspace_clear",
    ]);
  });

  it("migrates the viewed-file table in the dedicated plugin database", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });

    await plugin(bb);

    expect(
      bb.storage
        .database()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_viewed_files'",
        )
        .get(),
    ).toEqual({ name: "review_viewed_files" });
  });

  it("persists viewed state per revision and enforces file and thread boundaries", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const first = randomUUID();
    const otherThread = randomUUID();
    const otherRevision = randomUUID();
    seedReview(bb, { id: first, threadId: "thread-a", createdAt: 1 });
    seedReview(bb, {
      id: otherRevision,
      threadId: otherThread,
      createdAt: 2,
    });

    await harness.behavior.callRpc("markFileViewed", {
      reviewId: first,
      filePath: "src/example.ts",
      viewed: true,
    });
    await expect(
      harness.behavior.callRpc("markFileViewed", {
        reviewId: first,
        filePath: "src/example.ts",
        viewed: true,
      }),
    ).resolves.toMatchObject({ viewed: true, viewedCount: 1 });
    const loaded = await harness.behavior.callRpc("review", {
      threadId: "thread-a",
      reviewId: first,
    });
    expect(loaded).toMatchObject({
      review: { viewedPaths: ["src/example.ts"] },
    });
    expect(
      await harness.behavior.callRpc("review", {
        threadId: otherThread,
        reviewId: otherRevision,
      }),
    ).toMatchObject({ review: { viewedPaths: [] } });
    await expect(
      harness.behavior.callRpc("markFileViewed", {
        reviewId: first,
        filePath: "not-in-this-review.ts",
        viewed: true,
      }),
    ).rejects.toThrow("file is not part");
    expect(
      await harness.behavior.callRpc("review", {
        threadId: otherThread,
        reviewId: first,
      }),
    ).toEqual({ review: null });

    await harness.behavior.callRpc("markFileViewed", {
      reviewId: first,
      filePath: "src/example.ts",
      viewed: false,
    });
    expect(
      (
        (await harness.behavior.callRpc("review", {
          threadId: "thread-a",
          reviewId: first,
        })) as { review: { viewedPaths: string[] } }
      ).review.viewedPaths,
    ).toEqual([]);
  });

  it("counts files, comments, unresolved comments, and viewed rows without join multiplication", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const reviewId = randomUUID();
    const db = seedReview(bb, {
      id: reviewId,
      threadId: "thread-counts",
      createdAt: 1,
    });
    db.prepare(
      "INSERT INTO review_files (review_id, path, previous_path, status, additions, deletions, binary, patch, truncated) VALUES (?, 'src/second.ts', NULL, 'M', 2, 1, 0, '', 0)",
    ).run(reviewId);
    db.prepare(
      "INSERT INTO review_annotations (id, review_id, file_path, side, start_line, end_line, body, created_at) VALUES (?, ?, 'src/example.ts', 'new', 1, 1, 'first', 1), (?, ?, 'src/second.ts', 'new', 2, 2, 'second', 2)",
    ).run(randomUUID(), reviewId, randomUUID(), reviewId);
    await harness.behavior.callRpc("markFileViewed", {
      reviewId,
      filePath: "src/example.ts",
      viewed: true,
    });
    await harness.behavior.callRpc("markFileViewed", {
      reviewId,
      filePath: "src/second.ts",
      viewed: true,
    });

    await expect(
      harness.behavior.callRpc("revisions", { threadId: "thread-counts" }),
    ).resolves.toMatchObject({
      revisions: [
        {
          fileCount: 2,
          annotationCount: 2,
          unresolvedCount: 2,
          viewedCount: 2,
        },
      ],
    });
  });

  it("cascades comments, suggestions, files, and viewed state when clearing older revisions", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const oldRevision = randomUUID();
    const currentRevision = randomUUID();
    const oldAnnotation = randomUUID();
    const suggestion = randomUUID();
    const db = seedReview(bb, {
      id: oldRevision,
      threadId: "thread-cleanup",
      createdAt: 1,
    });
    seedReview(bb, {
      id: currentRevision,
      threadId: "thread-cleanup",
      createdAt: 2,
    });
    db.prepare(
      "INSERT INTO review_annotations (id, review_id, file_path, side, start_line, end_line, body, created_at) VALUES (?, ?, 'src/example.ts', 'new', 1, 1, 'old comment', 1)",
    ).run(oldAnnotation, oldRevision);
    db.prepare(
      "INSERT INTO review_resolution_suggestions (id, annotation_id, rationale, created_at, status) VALUES (?, ?, 'fixed', 1, 'pending')",
    ).run(suggestion, oldAnnotation);
    db.prepare(
      "INSERT INTO review_viewed_files (review_id, path, viewed_at) VALUES (?, 'src/example.ts', 1)",
    ).run(oldRevision);
    db.prepare(
      "INSERT INTO review_viewed_files (review_id, path, viewed_at) VALUES (?, 'src/example.ts', 2)",
    ).run(currentRevision);

    await expect(
      harness.behavior.callRpc("clearPreviousReviews", {
        threadId: "thread-cleanup",
        keepReviewId: currentRevision,
      }),
    ).resolves.toEqual({ deletedCount: 1 });
    expect(
      db
        .prepare("SELECT id FROM review_revisions WHERE id = ?")
        .get(oldRevision),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT id FROM review_annotations WHERE id = ?")
        .get(oldAnnotation),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT id FROM review_resolution_suggestions WHERE id = ?")
        .get(suggestion),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT review_id FROM review_viewed_files WHERE review_id = ?",
        )
        .get(oldRevision),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT id FROM review_revisions WHERE id = ?")
        .get(currentRevision),
    ).toEqual({ id: currentRevision });
    expect(
      db
        .prepare(
          "SELECT review_id FROM review_viewed_files WHERE review_id = ?",
        )
        .get(currentRevision),
    ).toEqual({ review_id: currentRevision });
  });

  it("creates immutable revisions, avoids duplicate snapshots, and stores expandable file contents", async () => {
    const listing = {
      outcome: "available" as const,
      files: [
        {
          path: "src/example.ts",
          previousPath: null,
          changeKind: "modified" as const,
          additions: 1,
          deletions: 1,
          binary: false,
          loadMode: "auto" as const,
          origin: "tracked" as const,
        },
      ],
      initialPatches: [],
      mergeBaseRef: null,
      shortstat: "1 insertion, 1 deletion",
      truncated: false,
    };
    const patch = `diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n context\n`;
    const diffFiles = vi.fn(async () => listing);
    const diffPatch = vi.fn(async () => ({
      outcome: "available" as const,
      patches: [{ path: "src/example.ts", patch, truncated: false }],
    }));
    const diffFile = vi.fn(async ({ side }: { side: "old" | "new" }) => ({
      path: "src/example.ts",
      content:
        side === "old" ? "context\nold\ncontext\n" : "context\nnew\ncontext\n",
      contentEncoding: "utf8" as const,
      sizeBytes: 20,
    }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: {
        threads: { get: async () => ({ environmentId: "env-1" }) },
        environments: { diffFiles, diffPatch, diffFile },
      },
    });
    await plugin(bb);

    const first = (await harness.behavior.callRpc("refreshReview", {
      threadId: "thread-refresh",
    })) as { review: { id: string; snapshot: string; files: unknown[] } };
    expect(first.review.files[0]).toMatchObject({
      path: "src/example.ts",
      patch,
      truncated: false,
    });
    const contents = await harness.behavior.callRpc("reviewFileContents", {
      reviewId: first.review.id,
      filePath: "src/example.ts",
    });
    expect(contents).toEqual({
      old: { path: "src/example.ts", content: "context\nold\ncontext\n" },
      new: { path: "src/example.ts", content: "context\nnew\ncontext\n" },
    });

    const duplicate = await harness.behavior.callRpc("refreshReview", {
      threadId: "thread-refresh",
    });
    expect(duplicate).toEqual({ review: first.review });
    expect(
      await harness.behavior.callRpc("revisions", {
        threadId: "thread-refresh",
      }),
    ).toMatchObject({ revisions: [{ id: first.review.id }] });

    diffFiles.mockResolvedValueOnce({
      ...listing,
      files: [{ ...listing.files[0], additions: 2 }],
    });
    diffFile.mockImplementation(async ({ side }: { side: "old" | "new" }) => ({
      path: "src/example.ts",
      content:
        side === "old"
          ? "context\nold-after-refresh\ncontext\n"
          : "context\nnew-after-refresh\ncontext\n",
      contentEncoding: "utf8" as const,
      sizeBytes: 20,
    }));
    const second = (await harness.behavior.callRpc("refreshReview", {
      threadId: "thread-refresh",
    })) as { review: { id: string; snapshot: string } };
    expect(second.review.id).not.toBe(first.review.id);
    expect(second.review.snapshot).not.toBe(first.review.snapshot);
    expect(
      await harness.behavior.callRpc("reviewFileContents", {
        reviewId: first.review.id,
        filePath: "src/example.ts",
      }),
    ).toEqual({
      old: { path: "src/example.ts", content: "context\nold\ncontext\n" },
      new: { path: "src/example.ts", content: "context\nnew\ncontext\n" },
    });
    const secondContents = await harness.behavior.callRpc(
      "reviewFileContents",
      {
        reviewId: second.review.id,
        filePath: "src/example.ts",
      },
    );
    expect(secondContents).toEqual({
      old: {
        path: "src/example.ts",
        content: "context\nold-after-refresh\ncontext\n",
      },
      new: {
        path: "src/example.ts",
        content: "context\nnew-after-refresh\ncontext\n",
      },
    });
    expect(
      await harness.behavior.callRpc("review", {
        threadId: "thread-refresh",
        reviewId: first.review.id,
      }),
    ).toMatchObject({ review: { id: first.review.id } });
    expect(diffFile).toHaveBeenCalledTimes(6);
  });

  it("refreshes against committed targets and exposes review_workspace_refresh", async () => {
    const listing = {
      outcome: "available" as const,
      files: [
        {
          path: "src/example.ts",
          previousPath: null,
          changeKind: "modified" as const,
          additions: 1,
          deletions: 1,
          binary: false,
          loadMode: "auto" as const,
          origin: "tracked" as const,
        },
      ],
      initialPatches: [],
      mergeBaseRef: null,
      shortstat: "1 insertion, 1 deletion",
      truncated: false,
    };
    const patch = `diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n context\n`;
    const diffFiles = vi.fn(async () => listing);
    const diffPatch = vi.fn(async () => ({
      outcome: "available" as const,
      patches: [{ path: "src/example.ts", patch, truncated: false }],
    }));
    const diffFile = vi.fn(async () => ({
      path: "src/example.ts",
      content: "content",
      contentEncoding: "utf8" as const,
      sizeBytes: 7,
    }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: {
        threads: { get: async () => ({ environmentId: "env-target" }) },
        environments: { diffFiles, diffPatch, diffFile },
      },
    });
    await plugin(bb);

    const call = (name: string, input: any) =>
      harness.behavior.callAgentTool(name, input, {
        threadId: "thread-target",
      });

    const prepared = await call("review_workspace_refresh", {
      target: { type: "commit", sha: "abc1234567890" },
    });
    expect(JSON.stringify(prepared)).toContain("commit abc1234567");
    expect(diffFiles).toHaveBeenCalledWith(
      expect.objectContaining({ target: "commit", sha: "abc1234567890" }),
    );
    expect(diffPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: "commit", sha: "abc1234567890" },
      }),
    );
    expect(diffFile).toHaveBeenCalledWith(
      expect.objectContaining({ target: "commit", sha: "abc1234567890" }),
    );

    await call("review_workspace_refresh", {
      target: { type: "branch_committed", mergeBaseBranch: "main" },
    });
    expect(diffFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: "branch_committed",
        mergeBaseBranch: "main",
      }),
    );
    expect(diffFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: "branch_committed",
        mergeBaseRef: "main",
      }),
    );

    // The stored revision keeps its target and the agent can annotate it.
    const status = await call("review_workspace_status", {});
    expect(JSON.stringify(status)).toContain("committed vs main");
    await call("review_workspace_comment", {
      filePath: "src/example.ts",
      side: "new",
      startLine: 2,
      body: "pre-annotated by agent",
    });
    const statusAfter = await call("review_workspace_status", {});
    expect(JSON.stringify(statusAfter)).toContain("pre-annotated by agent");
  });

  it("covers refresh failures and preserves binary or truncated patch metadata", async () => {
    const noEnvironment = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { get: async () => ({ environmentId: null }) } },
    });
    await plugin(noEnvironment.bb);
    await expect(
      noEnvironment.harness.behavior.callRpc("refreshReview", {
        threadId: "thread-no-env",
      }),
    ).rejects.toThrow("no environment");

    const listing = {
      outcome: "available" as const,
      files: [
        {
          path: "image.png",
          previousPath: null,
          changeKind: "added" as const,
          additions: 0,
          deletions: 0,
          binary: true,
          loadMode: "auto" as const,
          origin: "untracked" as const,
        },
        {
          path: "src/large.ts",
          previousPath: null,
          changeKind: "modified" as const,
          additions: 1,
          deletions: 1,
          binary: false,
          loadMode: "too_large" as const,
          origin: "tracked" as const,
        },
      ],
      initialPatches: [],
      mergeBaseRef: null,
      shortstat: "",
      truncated: true,
    };
    const diffPatch = vi.fn(async () => ({
      outcome: "available" as const,
      patches: [{ path: "src/large.ts", patch: "partial", truncated: true }],
    }));
    const diffFiles = vi.fn(async () => listing);
    const diffFailure = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: {
        threads: { get: async () => ({ environmentId: "env-2" }) },
        environments: {
          diffFiles,
          diffPatch,
          diffFile: async () => {
            throw new Error("must not load binary or too-large contents");
          },
        },
      },
    });
    await plugin(diffFailure.bb);
    const result = await diffFailure.harness.behavior.callRpc("refreshReview", {
      threadId: "thread-binary",
    });
    expect(result).toMatchObject({
      review: {
        files: [
          { path: "image.png", binary: true, patch: "", truncated: false },
          {
            path: "src/large.ts",
            binary: false,
            patch: "partial",
            truncated: true,
          },
        ],
      },
    });
    expect(
      diffFailure.harness.inspection.sdk.callsTo("environments.diffFile"),
    ).toEqual([]);

    diffFiles.mockResolvedValueOnce({
      outcome: "unavailable" as const,
      failure: {
        code: "unknown" as const,
        message: "diff unavailable",
        workspacePath: "/tmp/worktree",
      },
    } as any);
    await expect(
      diffFailure.harness.behavior.callRpc("refreshReview", {
        threadId: "thread-binary",
      }),
    ).rejects.toThrow("diff unavailable");
  });

  it("propagates file-level anchoring to replies", async () => {
    const send = vi.fn(async () => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { send } },
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, {
      id: reviewId,
      threadId: "thread-filelevel-reply",
      createdAt: 1,
    });

    const root = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      body: "file-level root",
      fileLevel: true,
    })) as { annotation: { id: string; fileLevel: boolean } };
    expect(root.annotation.fileLevel).toBe(true);

    const reply = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 7,
      endLine: 7,
      body: "reply ignores caller lines",
      parentId: root.annotation.id,
    })) as {
      annotation: {
        id: string;
        parentId: string | null;
        fileLevel: boolean;
        startLine: number;
        endLine: number;
        side: string;
        filePath: string;
      };
    };
    // Replies inherit the whole file-level anchor wholesale.
    expect(reply.annotation.fileLevel).toBe(true);
    expect(reply.annotation.startLine).toBe(0);
    expect(reply.annotation.endLine).toBe(0);
    expect(reply.annotation.filePath).toBe("src/example.ts");

    // Batch text labels the thread root as a whole file.
    await harness.behavior.callRpc("sendBatch", {
      reviewId,
      annotationIds: [reply.annotation.id],
    });
    const text = (send.mock.calls[0] as any[])[0].input[0].text as string;
    expect(text).toContain("src/example.ts (whole file)");
    expect(text).not.toContain("src/example.ts:0");
  });

  it("threads replies: caps depth, cascades resolve, guards remove, sends context", async () => {
    const send = vi.fn(async () => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { send } },
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-replies", createdAt: 1 });
    const call = (name: string, input: any) =>
      harness.behavior.callAgentTool(name, input, {
        threadId: "thread-replies",
      });

    const root = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "root",
    })) as { annotation: { id: string } };

    const humanReply = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 9,
      endLine: 9,
      body: "human reply",
      parentId: root.annotation.id,
    })) as {
      annotation: {
        id: string;
        parentId: string | null;
        filePath: string;
        startLine: number;
      };
    };
    expect(humanReply.annotation.parentId).toBe(root.annotation.id);
    // Reply inherits the parent anchor, not the caller-supplied lines.
    expect(humanReply.annotation.filePath).toBe("src/example.ts");
    expect(humanReply.annotation.startLine).toBe(1);

    // Depth cap: replies to replies are rejected.
    await expect(
      harness.behavior.callRpc("addAnnotation", {
        reviewId,
        filePath: "src/example.ts",
        side: "new",
        startLine: 1,
        endLine: 1,
        body: "nested",
        parentId: humanReply.annotation.id,
      }),
    ).rejects.toThrow("limited to one top-level");

    // Agent reply via the tool, targeting the root by parentId only.
    const agentReply = await call("review_workspace_comment", {
      body: "agent reply",
      parentId: root.annotation.id,
    });
    expect(JSON.stringify(agentReply)).toContain("Reply");

    // Roots with replies cannot be removed.
    await expect(
      harness.behavior.callRpc("removeAnnotation", {
        annotationId: root.annotation.id,
      }),
    ).rejects.toThrow("has replies");

    // Resolving the root resolves the whole thread.
    await harness.behavior.callRpc("resolveAnnotation", {
      annotationId: root.annotation.id,
      resolved: true,
    });
    const resolvedRows = (
      bb.storage
        .database()
        .prepare(
          "SELECT resolved_at FROM review_annotations WHERE review_id = ?",
        )
        .all(reviewId) as Array<{ resolved_at: number | null }>
    ).map((row) => row.resolved_at);
    expect(resolvedRows).toHaveLength(3);
    expect(resolvedRows.every((value) => value !== null)).toBe(true);

    // Reopening the root reopens the thread.
    await harness.behavior.callRpc("resolveAnnotation", {
      annotationId: root.annotation.id,
      resolved: false,
    });
    const reopened = (
      bb.storage
        .database()
        .prepare(
          "SELECT resolved_at FROM review_annotations WHERE review_id = ?",
        )
        .all(reviewId) as Array<{ resolved_at: number | null }>
    ).map((row) => row.resolved_at);
    expect(reopened.every((value) => value === null)).toBe(true);
  });

  it("sends threads with ids and includes the agent root as context for replies", async () => {
    const send = vi.fn(async (_input: unknown) => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { send } },
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, {
      id: reviewId,
      threadId: "thread-send-context",
      createdAt: 1,
    });
    const call = (name: string, input: any) =>
      harness.behavior.callAgentTool(name, input, {
        threadId: "thread-send-context",
      });

    const agentRoot = await call("review_workspace_comment", {
      filePath: "src/example.ts",
      side: "new",
      startLine: 3,
      body: "agent root observation",
    });
    const rootText = String(
      (agentRoot as { content: Array<{ text: string }> }).content[0]?.text,
    );
    const rootId = /Comment ([0-9a-f-]{36}) added/.exec(rootText)![1];
    const humanReply = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 3,
      endLine: 3,
      body: "please fix",
      parentId: rootId,
    })) as { annotation: { id: string } };

    // Sending just the human reply pulls the agent root in as context.
    await harness.behavior.callRpc("sendBatch", {
      reviewId,
      annotationIds: [humanReply.annotation.id],
    });
    const sentText = JSON.stringify(send.mock.calls[0]?.[0]);
    expect(sentText).toContain("[id: " + rootId + "]");
    expect(sentText).toContain("[context]");
    expect(sentText).toContain("reply (human)");
    expect(sentText).toContain("agent root observation");

    // Agent comments still cannot be primary batch selections.
    await expect(
      harness.behavior.callRpc("sendBatch", {
        reviewId: (() => {
          const second = randomUUID();
          seedReview(bb, {
            id: second,
            threadId: "thread-send-context",
            createdAt: 2,
          });
          return second;
        })(),
        annotationIds: [rootId],
      }),
    ).rejects.toThrow("cannot be sent back");
  });

  it("carries threads with parent remapping to the next revision", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const first = randomUUID();
    const second = randomUUID();
    seedReview(bb, { id: first, threadId: "thread-carry", createdAt: 1 });
    seedReview(bb, { id: second, threadId: "thread-carry", createdAt: 2 });
    const root = (await harness.behavior.callRpc("addAnnotation", {
      reviewId: first,
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "root",
    })) as { annotation: { id: string } };
    await harness.behavior.callRpc("addAnnotation", {
      reviewId: first,
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "reply",
      parentId: root.annotation.id,
    });

    const carried = (await harness.behavior.callRpc("carryForward", {
      sourceReviewId: first,
      targetReviewId: second,
      annotationIds: [root.annotation.id],
    })) as { annotations: Array<{ parentId: string | null; body: string }> };
    expect(carried.annotations).toHaveLength(1);
    // The reply is carried implicitly with its root; verify the remapped tree.
    const target = (await harness.behavior.callRpc("review", {
      threadId: "thread-carry",
    })) as {
      review: {
        annotations: Array<{
          id: string;
          parentId: string | null;
          body: string;
        }>;
      };
    };
    const carriedRoot = target.review.annotations.find(
      (a) => a.body === "root",
    )!;
    const carriedReply = target.review.annotations.find(
      (a) => a.body === "reply",
    )!;
    expect(carriedRoot.parentId).toBeNull();
    expect(carriedReply.parentId).toBe(carriedRoot.id);
  });

  it("marks agent comments and never sends them back to the agent", async () => {
    const send = vi.fn(async () => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { send } },
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-agent", createdAt: 1 });
    const call = (name: string, input: any) =>
      harness.behavior.callAgentTool(name, input, { threadId: "thread-agent" });

    await call("review_workspace_comment", {
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      body: "agent observation",
    });
    const db = bb.storage.database();
    const agentRow = db
      .prepare(
        "SELECT id, author FROM review_annotations WHERE body = 'agent observation'",
      )
      .get() as { id: string; author: string };
    expect(agentRow.author).toBe("agent");

    const human = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 2,
      endLine: 2,
      body: "human comment",
    })) as { annotation: { id: string; author: string } };
    expect(human.annotation.author).toBe("human");

    // Agent comments are not sendable back to the agent.
    await expect(
      harness.behavior.callRpc("sendBatch", {
        reviewId,
        annotationIds: [agentRow.id],
      }),
    ).rejects.toThrow("cannot be sent back");
    // Human comments still send fine.
    await expect(
      harness.behavior.callRpc("sendBatch", {
        reviewId,
        annotationIds: [human.annotation.id],
      }),
    ).resolves.toMatchObject({ count: 1 });
  });

  it("adds, removes, resolves, and rejects invalid annotation transitions", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-comments", createdAt: 1 });

    const added = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 8,
      endLine: 3,
      body: "  check this  ",
    })) as { annotation: { id: string } };
    expect(added.annotation).toMatchObject({
      startLine: 3,
      endLine: 8,
      body: "check this",
      resolvedAt: null,
      sentAt: null,
      author: "human",
    });
    await expect(
      harness.behavior.callRpc("resolveAnnotation", {
        annotationId: added.annotation.id,
        resolved: true,
      }),
    ).resolves.toMatchObject({ resolvedAt: expect.any(Number) });
    await expect(
      harness.behavior.callRpc("resolveAnnotation", {
        annotationId: added.annotation.id,
        resolved: false,
      }),
    ).resolves.toEqual({ resolvedAt: null });
    await harness.behavior.callRpc("removeAnnotation", {
      annotationId: added.annotation.id,
    });
    expect(
      bb.storage
        .database()
        .prepare("SELECT id FROM review_annotations WHERE id = ?")
        .get(added.annotation.id),
    ).toBeUndefined();

    const sent = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "sent",
    })) as { annotation: { id: string } };
    bb.storage
      .database()
      .prepare("UPDATE review_annotations SET sent_at = 10 WHERE id = ?")
      .run(sent.annotation.id);
    await harness.behavior.callRpc("removeAnnotation", {
      annotationId: sent.annotation.id,
    });
    expect(
      bb.storage
        .database()
        .prepare("SELECT id FROM review_annotations WHERE id = ?")
        .get(sent.annotation.id),
    ).toEqual({ id: sent.annotation.id });
    await expect(
      harness.behavior.callRpc("resolveAnnotation", {
        annotationId: randomUUID(),
        resolved: true,
      }),
    ).rejects.toThrow("not found");
  });

  it("carries only unresolved comments to the latest revision once", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const sourceId = randomUUID();
    const targetId = randomUUID();
    const laterId = randomUUID();
    const otherThreadRevisionId = randomUUID();
    seedReview(bb, { id: sourceId, threadId: "thread-carry", createdAt: 1 });
    seedReview(bb, { id: targetId, threadId: "thread-carry", createdAt: 2 });
    const open = (await harness.behavior.callRpc("addAnnotation", {
      reviewId: sourceId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 2,
      endLine: 2,
      body: "carry me",
    })) as { annotation: { id: string } };
    const resolved = (await harness.behavior.callRpc("addAnnotation", {
      reviewId: sourceId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 4,
      endLine: 4,
      body: "already fixed",
    })) as { annotation: { id: string } };
    await harness.behavior.callRpc("resolveAnnotation", {
      annotationId: resolved.annotation.id,
      resolved: true,
    });

    const carried = await harness.behavior.callRpc("carryForward", {
      sourceReviewId: sourceId,
      targetReviewId: targetId,
      annotationIds: [open.annotation.id],
    });
    expect(carried).toMatchObject({
      annotations: [{ carriedFromAnnotationId: open.annotation.id }],
    });
    await expect(
      harness.behavior.callRpc("carryForward", {
        sourceReviewId: sourceId,
        targetReviewId: targetId,
        annotationIds: [open.annotation.id],
      }),
    ).resolves.toMatchObject({
      annotations: [{ carriedFromAnnotationId: open.annotation.id }],
    });
    await expect(
      harness.behavior.callRpc("carryForward", {
        sourceReviewId: sourceId,
        targetReviewId: targetId,
        annotationIds: [resolved.annotation.id],
      }),
    ).rejects.toThrow("unresolved");

    seedReview(bb, { id: laterId, threadId: "thread-carry", createdAt: 3 });
    await expect(
      harness.behavior.callRpc("carryForward", {
        sourceReviewId: sourceId,
        targetReviewId: targetId,
        annotationIds: [open.annotation.id],
      }),
    ).rejects.toThrow("latest");
    seedReview(bb, {
      id: otherThreadRevisionId,
      threadId: "other-thread",
      createdAt: 4,
    });
    await expect(
      harness.behavior.callRpc("carryForward", {
        sourceReviewId: sourceId,
        targetReviewId: otherThreadRevisionId,
        annotationIds: [open.annotation.id],
      }),
    ).rejects.toThrow("same thread");
  });

  it("records resolution suggestions and lets humans accept or reject them", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, {
      id: reviewId,
      threadId: "thread-suggestions",
      createdAt: 1,
    });
    const added = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "please fix",
    })) as { annotation: { id: string } };

    const suggestionId = randomUUID();
    bb.storage
      .database()
      .prepare(
        "INSERT INTO review_resolution_suggestions (id, annotation_id, rationale, created_at, status) VALUES (?, ?, 'fixed in the patch', 1, 'pending')",
      )
      .run(suggestionId, added.annotation.id);
    expect(
      await harness.behavior.callRpc("review", {
        threadId: "thread-suggestions",
      }),
    ).toMatchObject({
      review: {
        annotations: [
          {
            resolutionSuggestion: { rationale: "fixed in the patch" },
            resolvedAt: null,
          },
        ],
      },
    });
    await expect(
      harness.behavior.callRpc("decideResolutionSuggestion", {
        suggestionId,
        accept: true,
      }),
    ).resolves.toMatchObject({ resolvedAt: expect.any(Number) });
    await expect(
      harness.behavior.callRpc("decideResolutionSuggestion", {
        suggestionId,
        accept: true,
      }),
    ).rejects.toThrow("not found");
  });

  it("claims send batches atomically, clears claims on failure, and allows retry", async () => {
    const send = vi.fn(async () => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { send } },
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-send", createdAt: 1 });
    const add = async (body: string) =>
      (await harness.behavior.callRpc("addAnnotation", {
        reviewId,
        filePath: "src/example.ts",
        side: "new",
        startLine: 1,
        endLine: 1,
        body,
      })) as { annotation: { id: string } };
    const first = await add("first");
    const second = await add("second");

    await expect(
      harness.behavior.callRpc("sendBatch", {
        reviewId,
        annotationIds: [
          first.annotation.id,
          first.annotation.id,
          second.annotation.id,
        ],
      }),
    ).resolves.toMatchObject({ count: 2, sentAt: expect.any(Number) });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-send",
        input: [
          expect.objectContaining({ text: expect.stringContaining("first") }),
        ],
      }),
    );
    await expect(
      harness.behavior.callRpc("sendBatch", {
        reviewId,
        annotationIds: [first.annotation.id],
      }),
    ).rejects.toThrow("already sent");

    const retry = await add("retry");
    send.mockRejectedValueOnce(new Error("temporary send failure"));
    await expect(
      harness.behavior.callRpc("sendBatch", {
        reviewId,
        annotationIds: [retry.annotation.id],
      }),
    ).rejects.toThrow("temporary send failure");
    expect(
      bb.storage
        .database()
        .prepare(
          "SELECT sent_at, batch_id FROM review_annotations WHERE id = ?",
        )
        .get(retry.annotation.id),
    ).toEqual({ sent_at: null, batch_id: null });
    await expect(
      harness.behavior.callRpc("sendBatch", {
        reviewId,
        annotationIds: [retry.annotation.id],
      }),
    ).resolves.toMatchObject({ count: 1 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("stores file-level notes per revision and rejects unknown files", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-notes", createdAt: 1 });
    seedReview(bb, {
      id: randomUUID(),
      threadId: "thread-notes",
      createdAt: 2,
      path: "src/other.ts",
    });

    await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      body: "  normalizes query text  ",
      fileLevel: true,
    });
    await expect(
      harness.behavior.callRpc("review", {
        threadId: "thread-notes",
        reviewId,
      }),
    ).resolves.toMatchObject({
      review: {
        annotations: [
          {
            filePath: "src/example.ts",
            body: "normalizes query text",
            fileLevel: true,
            startLine: 0,
          },
        ],
      },
    });
    await expect(
      harness.behavior.callRpc("addAnnotation", {
        reviewId,
        filePath: "not-in-this-review.ts",
        body: "x",
      }),
    ).rejects.toThrow("file is not part");
  });

  it("stores, updates, clears, and batches the review-level note", async () => {
    const send = vi.fn(async () => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { send } },
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, {
      id: reviewId,
      threadId: "thread-review-note",
      createdAt: 1,
    });

    await expect(
      harness.behavior.callRpc("review", { threadId: "thread-review-note" }),
    ).resolves.toMatchObject({ review: { summary: null } });
    await harness.behavior.callRpc("setReviewSummary", {
      reviewId,
      summary: "  solid change overall  ",
    });
    await expect(
      harness.behavior.callRpc("review", { threadId: "thread-review-note" }),
    ).resolves.toMatchObject({
      review: { summary: "solid change overall" },
    });
    await expect(
      harness.behavior.callRpc("setReviewSummary", {
        reviewId,
        summary: "   ",
      }),
    ).resolves.toEqual({ summary: null });
    await expect(
      harness.behavior.callRpc("setReviewSummary", {
        reviewId: randomUUID(),
        summary: "x",
      }),
    ).rejects.toThrow("not found");

    await harness.behavior.callRpc("setReviewSummary", {
      reviewId,
      summary: "Overall verdict text",
    });
    const added = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "please fix",
    })) as { annotation: { id: string } };
    await harness.behavior.callRpc("sendBatch", {
      reviewId,
      annotationIds: [added.annotation.id],
    });
    const text = (send.mock.calls[0] as any[])[0].input[0].text as string;
    expect(text).toContain("Review summary:");
    expect(text).toContain("Overall verdict text");
  });

  it("sends notes without comments and rejects truly empty batches", async () => {
    const send = vi.fn(async () => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { send } },
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, {
      id: reviewId,
      threadId: "thread-notes-only",
      createdAt: 1,
    });

    await expect(
      harness.behavior.callRpc("sendBatch", { reviewId, annotationIds: [] }),
    ).rejects.toThrow("Nothing to send");

    await harness.behavior.callRpc("setReviewSummary", {
      reviewId,
      summary: "Overall verdict text",
    });
    await harness.behavior.callRpc("sendBatch", {
      reviewId,
      annotationIds: [],
    });
    const text = (send.mock.calls[0] as any[])[0].input[0].text as string;
    expect(text).toContain("Review summary:");
    expect(text).toContain("Overall verdict text");
    expect(text).not.toMatch(/- src\/example\.ts/);
  });

  it("exposes agent tools for status, commenting, and resolution", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-tools", createdAt: 1 });
    const call = (name: string, input: any, threadId?: string) =>
      harness.behavior.callAgentTool(name, input, { threadId });

    const status = await call("review_workspace_status", {}, "thread-tools");
    const statusText = JSON.stringify(status);
    expect(statusText).toContain("Unresolved comments (0)");
    expect(statusText).toContain("src/example.ts");

    await expect(
      call("review_workspace_status", {}, "unknown-thread"),
    ).resolves.toMatchObject({
      content: [{ text: "No review revision exists yet." }],
    });

    const added = await call(
      "review_workspace_comment",
      {
        filePath: "src/example.ts",
        side: "new",
        startLine: 4,
        endLine: 2,
        body: "  agent-found issue  ",
      },
      "thread-tools",
    );
    expect(JSON.stringify(added)).toContain("2-4");
    await expect(
      call(
        "review_workspace_comment",
        {
          filePath: "nope.ts",
          side: "new",
          startLine: 1,
          body: "x",
        },
        "thread-tools",
      ),
    ).rejects.toThrow("file is not part");

    const db = bb.storage.database();
    const annotationRow = db
      .prepare("SELECT id, author FROM review_annotations WHERE review_id = ?")
      .get(reviewId) as { id: string; author: string };
    expect(annotationRow.author).toBe("agent");
    await expect(
      call("review_workspace_resolve", {
        commentId: annotationRow.id,
        resolved: true,
      }),
    ).resolves.toMatchObject({ content: [{ text: "Comment resolved." }] });
    await expect(
      call("review_workspace_resolve", {
        commentId: randomUUID(),
        resolved: true,
      }),
    ).rejects.toThrow("not found");
    await expect(
      call("review_workspace_comment", {
        filePath: "src/example.ts",
        side: "new",
        startLine: 1,
        body: "x",
      }),
    ).rejects.toThrow("No review revision exists yet.");
  });

  it("includes only comment-anchored hunks in batch messages", async () => {
    const send = vi.fn(async () => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { send } },
    });
    await plugin(bb);
    const db = bb.storage.database();
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-diff", createdAt: 1 });
    db.prepare("UPDATE review_files SET patch = ? WHERE review_id = ?").run(
      "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new",
      reviewId,
    );
    const added = (await harness.behavior.callRpc("addAnnotation", {
      reviewId,
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "fix this",
    })) as { annotation: { id: string } };

    await harness.behavior.callRpc("sendBatch", {
      reviewId,
      annotationIds: [added.annotation.id],
    });
    const text = (send.mock.calls[0] as any[])[0].input[0].text as string;
    expect(text).toContain("Diff of the reviewed changes:");
    expect(text).toContain("+new");

    // notes-only batches carry no diff
    await harness.behavior.callRpc("setReviewSummary", {
      reviewId,
      summary: "verdict",
    });
    await harness.behavior.callRpc("sendBatch", {
      reviewId,
      annotationIds: [],
    });
    const text2 = (send.mock.calls[1] as any[])[0].input[0].text as string;
    expect(text2).not.toContain("Diff of the reviewed changes:");
  });

  it("auto-carries unresolved comments, review note, and file notes on refresh", async () => {
    const listing = {
      outcome: "available" as const,
      files: [
        {
          path: "src/example.ts",
          previousPath: null,
          changeKind: "modified" as const,
          additions: 1,
          deletions: 1,
          binary: false,
          loadMode: "auto" as const,
          origin: "tracked" as const,
        },
      ],
      initialPatches: [],
      mergeBaseRef: null,
      shortstat: "1 insertion, 1 deletion",
      truncated: false,
    };
    const patch = `diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n context\n`;
    const diffFiles = vi.fn(async () => listing);
    const diffPatch = vi.fn(async () => ({
      outcome: "available" as const,
      patches: [{ path: "src/example.ts", patch, truncated: false }],
    }));
    const diffFile = vi.fn(async ({ side }: { side: "old" | "new" }) => ({
      path: "src/example.ts",
      content:
        side === "old" ? "context\nold\ncontext\n" : "context\nnew\ncontext\n",
      contentEncoding: "utf8" as const,
      sizeBytes: 20,
    }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: {
        threads: { get: async () => ({ environmentId: "env-1" }) },
        environments: { diffFiles, diffPatch, diffFile },
      },
    });
    await plugin(bb);

    const first = (await harness.behavior.callRpc("refreshReview", {
      threadId: "thread-autocarry",
    })) as { review: { id: string; snapshot: string } };
    const open = (await harness.behavior.callRpc("addAnnotation", {
      reviewId: first.review.id,
      filePath: "src/example.ts",
      side: "new",
      startLine: 2,
      endLine: 2,
      body: "still applies",
    })) as { annotation: { id: string } };
    const resolved = (await harness.behavior.callRpc("addAnnotation", {
      reviewId: first.review.id,
      filePath: "src/example.ts",
      side: "new",
      startLine: 3,
      endLine: 3,
      body: "addressed",
    })) as { annotation: { id: string } };
    await harness.behavior.callRpc("resolveAnnotation", {
      annotationId: resolved.annotation.id,
      resolved: true,
    });
    await harness.behavior.callRpc("setReviewSummary", {
      reviewId: first.review.id,
      summary: "carried verdict",
    });
    const fileLevel = (await harness.behavior.callRpc("addAnnotation", {
      reviewId: first.review.id,
      filePath: "src/example.ts",
      body: "carried file comment",
      fileLevel: true,
    })) as { annotation: { id: string } };

    diffFile.mockImplementation(async ({ side }: { side: "old" | "new" }) => ({
      path: "src/example.ts",
      content:
        side === "old"
          ? "context\nold-changed\ncontext\n"
          : "context\nnew-changed\ncontext\n",
      contentEncoding: "utf8" as const,
      sizeBytes: 20,
    }));
    const second = (await harness.behavior.callRpc("refreshReview", {
      threadId: "thread-autocarry",
    })) as {
      review: {
        id: string;
        summary: string | null;
        annotations: Array<Record<string, unknown>>;
      };
    };
    expect(second.review.id).not.toBe(first.review.id);
    expect(second.review.annotations).toHaveLength(2);
    expect(second.review.annotations[0]).toMatchObject({
      body: "still applies",
      carriedFromAnnotationId: open.annotation.id,
    });
    const carried = second.review.annotations[1];
    expect(carried).toMatchObject({
      body: "carried file comment",
      fileLevel: true,
      parentId: null,
      carriedFromAnnotationId: fileLevel.annotation.id,
    });
    expect(second.review.summary).toBe("carried verdict");

    // the old revision is untouched (immutable)
    const before = (await harness.behavior.callRpc("review", {
      threadId: "thread-autocarry",
      reviewId: first.review.id,
    })) as { review: { annotations: unknown[]; summary: string | null } };
    expect(before.review.annotations).toHaveLength(3);
    expect(before.review.summary).toBe("carried verdict");

    // carried comment dedupes: a third refresh with a new snapshot carries
    // the carried comment only once
    diffFile.mockImplementation(async ({ side }: { side: "old" | "new" }) => ({
      path: "src/example.ts",
      content:
        side === "old"
          ? "context\nold-changed-again\ncontext\n"
          : "context\nnew-changed-again\ncontext\n",
      contentEncoding: "utf8" as const,
      sizeBytes: 20,
    }));
    const third = (await harness.behavior.callRpc("refreshReview", {
      threadId: "thread-autocarry",
    })) as { review: { annotations: unknown[] } };
    expect(third.review.annotations).toHaveLength(2);
  });

  it("clears reviews for one thread or everything", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const db = bb.storage.database();
    const a = randomUUID();
    const b = randomUUID();
    seedReview(bb, { id: a, threadId: "thread-clear-a", createdAt: 1 });
    seedReview(bb, { id: b, threadId: "thread-clear-b", createdAt: 2 });
    const call = (input: any, threadId: string) =>
      harness.behavior.callAgentTool("review_workspace_clear", input, {
        threadId,
      });

    await call({ scope: "thread" }, "thread-clear-a");
    expect(db.prepare("SELECT COUNT(*) n FROM review_revisions").get()).toEqual(
      { n: 1 },
    );
    await call({ scope: "all" }, "thread-clear-a");
    expect(db.prepare("SELECT COUNT(*) n FROM review_revisions").get()).toEqual(
      { n: 0 },
    );
    expect(
      db.prepare("SELECT COUNT(*) n FROM review_annotations").get(),
    ).toEqual({ n: 0 });
  });

  it("backfills summary from legacy body rows", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const reviewId = randomUUID();
    const db = seedReview(bb, {
      id: reviewId,
      threadId: "thread-legacy",
      createdAt: 1,
    });
    db.prepare(
      "INSERT INTO review_annotations (id, review_id, file_path, side, start_line, end_line, body, created_at) VALUES (?, ?, 'src/example.ts', 'new', 1, 1, 'legacy text', 1)",
    ).run(randomUUID(), reviewId);

    await expect(
      harness.behavior.callRpc("review", { threadId: "thread-legacy" }),
    ).resolves.toMatchObject({
      review: {
        annotations: [{ body: "legacy text" }],
      },
    });
  });

  it("lists review revisions from other threads in the same project", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: {
        threads: {
          get: vi.fn(async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            projectId: "proj-1",
            environmentId: threadId === "thread-caller" ? "env-1" : "env-2",
          })),
          list: vi.fn(async () => [
            {
              id: "thread-caller",
              title: "Caller",
              titleFallback: null,
              visibility: "visible",
              environmentId: "env-1",
            },
            {
              id: "thread-same-env",
              title: "Same env",
              titleFallback: null,
              visibility: "visible",
              environmentId: "env-1",
            },
            {
              id: "thread-other-env",
              title: "Other env",
              titleFallback: null,
              visibility: "visible",
              environmentId: "env-2",
            },
            {
              id: "thread-hidden",
              title: "Hidden panel",
              titleFallback: null,
              visibility: "hidden",
              environmentId: "env-1",
            },
          ]),
        },
      },
    });
    await plugin(bb);
    seedReview(bb, {
      id: randomUUID(),
      threadId: "thread-caller",
      createdAt: 1,
    });
    seedReview(bb, {
      id: randomUUID(),
      threadId: "thread-same-env",
      createdAt: 2,
    });
    seedReview(bb, {
      id: randomUUID(),
      threadId: "thread-other-env",
      createdAt: 3,
    });
    seedReview(bb, {
      id: randomUUID(),
      threadId: "thread-hidden",
      createdAt: 4,
    });

    const result = await harness.behavior.callAgentTool(
      "review_workspace_history",
      {},
      { threadId: "thread-caller" },
    );
    const text = (result as any).content[0].text as string;
    expect(text).toContain('"Same env"');
    expect(text).toContain("[same environment]");
    expect(text).toContain('"Other env"');
    expect(text).not.toContain("Hidden panel");
    expect(text).not.toContain('"Caller"');
  });

  it("imports unresolved comments across threads with tree remapping", async () => {
    const threadsGet = vi.fn(async ({ threadId }: { threadId: string }) => ({
      id: threadId,
      projectId: "proj-1",
      environmentId: "env-1",
    }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: { threads: { get: threadsGet } },
    });
    await plugin(bb);
    const source = randomUUID();
    const target = randomUUID();
    seedReview(bb, { id: source, threadId: "thread-old", createdAt: 1 });
    seedReview(bb, { id: target, threadId: "thread-new", createdAt: 2 });
    const root = (await harness.behavior.callRpc("addAnnotation", {
      reviewId: source,
      filePath: "src/example.ts",
      side: "new",
      startLine: 5,
      endLine: 5,
      body: "old root feedback",
    })) as { annotation: { id: string } };
    await harness.behavior.callRpc("addAnnotation", {
      reviewId: source,
      filePath: "src/example.ts",
      side: "new",
      startLine: 5,
      endLine: 5,
      body: "old reply",
      parentId: root.annotation.id,
    });
    // A resolved comment that must not be imported.
    const resolved = (await harness.behavior.callRpc("addAnnotation", {
      reviewId: source,
      filePath: "src/example.ts",
      side: "new",
      startLine: 9,
      endLine: 9,
      body: "already handled",
    })) as { annotation: { id: string } };
    await harness.behavior.callRpc("resolveAnnotation", {
      annotationId: resolved.annotation.id,
      resolved: true,
    });

    const result = await harness.behavior.callAgentTool(
      "review_workspace_import",
      { reviewId: source },
      { threadId: "thread-new" },
    );
    const text = (result as any).content[0].text as string;
    expect(text).toContain("Imported 2 comment(s)");
    expect(text).not.toContain("already handled");

    const targetReview = (await harness.behavior.callRpc("review", {
      threadId: "thread-new",
    })) as {
      review: {
        annotations: Array<{
          id: string;
          parentId: string | null;
          body: string;
          carriedFromAnnotationId: string | null;
        }>;
      };
    };
    const importedRoot = targetReview.review.annotations.find(
      (a) => a.body === "old root feedback",
    )!;
    const importedReply = targetReview.review.annotations.find(
      (a) => a.body === "old reply",
    )!;
    expect(importedRoot.parentId).toBeNull();
    expect(importedRoot.carriedFromAnnotationId).toBe(root.annotation.id);
    expect(importedReply.parentId).toBe(importedRoot.id);
  });

  it("rejects importing from another project and without a target revision", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
      sdk: {
        threads: {
          get: vi.fn(async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            projectId: threadId === "thread-caller" ? "proj-1" : "proj-other",
            environmentId: "env-1",
          })),
        },
      },
    });
    await plugin(bb);
    const source = randomUUID();
    seedReview(bb, {
      id: source,
      threadId: "thread-other-project",
      createdAt: 1,
    });

    // No target revision yet.
    await expect(
      harness.behavior.callAgentTool(
        "review_workspace_import",
        { reviewId: source },
        { threadId: "thread-caller" },
      ),
    ).rejects.toThrow("review_workspace_refresh first");

    seedReview(bb, {
      id: randomUUID(),
      threadId: "thread-caller",
      createdAt: 2,
    });
    await expect(
      harness.behavior.callAgentTool(
        "review_workspace_import",
        { reviewId: source },
        { threadId: "thread-caller" },
      ),
    ).rejects.toThrow("same project");
  });
});

describe("entity summary (experimental, sem)", () => {
  vi.mock("./lib/sem", async () => {
    const actual = await vi.importActual("./lib/sem");
    return {
      ...(actual as object),
      runEntityDiff: vi.fn(),
    };
  });

  it("computes the whole revision with a single sem run and caches it", async () => {
    const { runEntityDiff } = (await import("./lib/sem")) as unknown as {
      runEntityDiff: ReturnType<typeof vi.fn>;
    };
    runEntityDiff.mockResolvedValue({
      status: "ok",
      changes: [
        {
          entityId: "src/example.ts::function::one",
          changeType: "added",
          entityType: "function",
          entityName: "one",
          startLine: 3,
          endLine: 5,
          oldStartLine: null,
          oldEndLine: null,
          filePath: "src/example.ts",
          structuralChange: null,
        },
        {
          entityId: "src/other.ts::function::two",
          changeType: "modified",
          entityType: "function",
          entityName: "two",
          startLine: 2,
          endLine: 2,
          oldStartLine: 2,
          oldEndLine: 2,
          filePath: "src/other.ts",
          structuralChange: true,
        },
      ],
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    const db = bb.storage.database();
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-entities", createdAt: 1 });
    db.prepare(
      "INSERT INTO review_files (review_id, path, previous_path, status, additions, deletions, binary, patch, truncated) VALUES (?, ?, NULL, 'M', 1, 0, 0, '', 0)",
    ).run(reviewId, "src/other.ts");

    await expect(
      harness.behavior.callRpc("entitySummary", { reviewId }),
    ).resolves.toMatchObject({
      status: "ok",
      changes: [
        { entityId: "src/other.ts::function::two" },
        { entityId: "src/example.ts::function::one" },
      ],
    });
    // One sem run covered every file of the revision.
    expect(runEntityDiff).toHaveBeenCalledTimes(1);
    expect(runEntityDiff.mock.calls[0][0]).toHaveLength(2);
    // Cached payload exists for both files of the revision.
    const rows = db
      .prepare("SELECT path FROM review_entities WHERE review_id = ?")
      .all(reviewId);
    expect(rows).toHaveLength(2);
    await expect(
      harness.behavior.callRpc("entitySummary", { reviewId }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(runEntityDiff).toHaveBeenCalledTimes(1);
  });

  it("shares a single sem run across concurrent callers", async () => {
    const { runEntityDiff } = (await import("./lib/sem")) as unknown as {
      runEntityDiff: ReturnType<typeof vi.fn>;
    };
    let release!: () => void;
    runEntityDiff.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ status: "ok", changes: [] });
      }),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    runEntityDiff.mockClear();
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-entities", createdAt: 1 });

    const first = harness.behavior.callRpc("entitySummary", { reviewId });
    const second = harness.behavior.callRpc("entitySummary", { reviewId });
    release();
    await Promise.all([first, second]);
    console.log("spawn count", runEntityDiff.mock.calls.length);
    expect(runEntityDiff).toHaveBeenCalledTimes(1);
  });

  it("reports sem unavailability as a status instead of failing", async () => {
    const { runEntityDiff } = (await import("./lib/sem")) as unknown as {
      runEntityDiff: ReturnType<typeof vi.fn>;
    };
    runEntityDiff.mockResolvedValue({
      status: "unavailable",
      reason: "sem binary not found",
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    runEntityDiff.mockClear();
    const reviewId = randomUUID();
    seedReview(bb, { id: reviewId, threadId: "thread-no-sem", createdAt: 1 });

    await expect(
      harness.behavior.callRpc("entitySummary", { reviewId }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "sem binary not found",
      changes: [],
    });

    // unavailability is also cached
    expect(runEntityDiff).toHaveBeenCalledTimes(1);
    await expect(
      harness.behavior.callRpc("entitySummary", { reviewId }),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(runEntityDiff).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown revisions", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("entitySummary", {
        reviewId: randomUUID(),
      }),
    ).rejects.toThrow("Review revision was not found.");
  });
});

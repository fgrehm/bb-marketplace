import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

function seedSnapshot(
  bb: ReturnType<typeof createFakePluginHost>["bb"],
  threadId: string,
  createdAt: number,
  target = "uncommitted",
) {
  const id = randomUUID();
  const db = bb.storage.database();
  db.prepare(
    "INSERT INTO review_revisions (id, thread_id, snapshot, created_at, target) VALUES (?, ?, ?, ?, ?)",
  ).run(id, threadId, `snapshot-${id}`, createdAt, target);
  db.prepare(
    "INSERT INTO review_files (review_id, path, status, additions, deletions, binary, patch, truncated) VALUES (?, 'src/example.ts', 'M', 1, 0, 0, '', 0)",
  ).run(id);
  return id;
}

function seedComment(
  bb: ReturnType<typeof createFakePluginHost>["bb"],
  reviewId: string,
  options: {
    author?: "human" | "agent";
    parentId?: string;
    sentAt?: number;
    resolvedAt?: number;
  } = {},
) {
  const id = randomUUID();
  bb.storage
    .database()
    .prepare(
      "INSERT INTO review_annotations (id, review_id, file_path, side, start_line, end_line, body, created_at, author, parent_id, sent_at, resolved_at) VALUES (?, ?, 'src/example.ts', 'new', 1, 1, 'Feedback', 1, ?, ?, ?, ?)",
    )
    .run(
      id,
      reviewId,
      options.author ?? "human",
      options.parentId ?? null,
      options.sentAt ?? null,
      options.resolvedAt ?? null,
    );
  return id;
}

function host() {
  return createFakePluginHost({
    pluginId: "review-workspace",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            title: `Review ${threadId}`,
            projectId: "project-1",
          }),
      },
      projects: {
        list: async () => [{ id: "project-1", name: "Example project" }],
      },
    },
  });
}

describe("Recent review workspaces", () => {
  it("lists only the latest snapshot per thread, including timestamp ties, with sendable comment and viewed-file counts", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const old = seedSnapshot(bb, "thread-pending", 1);
    seedComment(bb, old);
    const latest = seedSnapshot(bb, "thread-pending", 2);
    const root = seedComment(bb, latest, { author: "agent" });
    seedComment(bb, latest, { parentId: root });
    seedComment(bb, latest, { sentAt: 9 });
    seedComment(bb, latest, { resolvedAt: 9 });
    const db = bb.storage.database();
    db.prepare(
      "INSERT INTO review_files (review_id, path, status, additions, deletions, binary, patch, truncated) VALUES (?, 'README.md', 'M', 1, 0, 0, '', 0)",
    ).run(latest);
    db.prepare(
      "INSERT INTO review_viewed_files (review_id, path, viewed_at) VALUES (?, ?, 1)",
    ).run(latest, "README.md");
    // A stale viewed path must not inflate progress beyond the snapshot's files.
    db.prepare(
      "INSERT INTO review_viewed_files (review_id, path, viewed_at) VALUES (?, ?, 1)",
    ).run(latest, "missing.ts");
    db.prepare(
      "INSERT INTO review_review_summaries (review_id, summary, updated_at) VALUES (?, 'A review note', 1)",
    ).run(latest);
    const obsoleteTie = seedSnapshot(bb, "thread-tie", 3);
    seedComment(bb, obsoleteTie);
    const tie = seedSnapshot(bb, "thread-tie", 3, "commit:1234567890abcdef");
    const recent = seedSnapshot(
      bb,
      "thread-recent",
      4,
      "branch_committed:main",
    );

    const result = await harness.behavior.callRpc("recentReviews", {});
    expect(result).toEqual({
      reviews: [
        {
          id: latest,
          threadId: "thread-pending",
          threadTitle: "Review thread-pending",
          projectId: "project-1",
          projectName: "Example project",
          createdAt: 2,
          target: { type: "uncommitted" },
          fileCount: 2,
          viewedCount: 1,
          pendingCount: 1,
        },
        expect.objectContaining({
          id: recent,
          target: { type: "branch_committed", mergeBaseBranch: "main" },
          pendingCount: 0,
        }),
        expect.objectContaining({
          id: tie,
          target: { type: "commit", sha: "1234567890abcdef" },
          pendingCount: 0,
        }),
      ],
    });
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(3);
    expect(harness.inspection.sdk.callsTo("projects.list")[0]).toEqual([
      { includePersonal: true },
    ]);
    expect(
      harness.inspection.sdk.callsTo("environments.diffFiles"),
    ).toHaveLength(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM review_revisions").get(),
    ).toEqual({ n: 5 });
  });

  it("omits hidden, archived, deleted and missing threads, and preserves personal-project and title fallbacks", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    const ids = [
      "hidden",
      "archived",
      "deleted",
      "missing",
      "fallback",
      "untitled",
    ];
    for (const id of ids) seedSnapshot(bb, id, 1);
    harness.sdk.stub(
      "threads.get",
      async ({ threadId }: { threadId: string }) => {
        if (threadId === "missing")
          throw Object.assign(new Error("Thread not found"), {
            status: 404,
            code: "thread_not_found",
          });
        return makeThreadResponse({
          id: threadId,
          projectId: "personal",
          title: null,
          titleFallback: threadId === "fallback" ? "Fix the retry flow" : null,
          visibility: threadId === "hidden" ? "hidden" : "visible",
          archivedAt: threadId === "archived" ? 10 : null,
          deletedAt: threadId === "deleted" ? 10 : null,
        });
      },
    );
    harness.sdk.stub("projects.list", async () => [
      { id: "personal", name: "Personal" },
    ]);
    const result = await harness.behavior.callRpc("recentReviews", {});
    expect(result).toMatchObject({
      reviews: [
        {
          threadId: "untitled",
          threadTitle: "Untitled thread",
          projectName: "Personal",
        },
        {
          threadId: "fallback",
          threadTitle: "Fix the retry flow",
          projectName: "Personal",
        },
      ],
    });
  });

  it("does not access the SDK when no reviews exist", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-workspace",
    });
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("recentReviews", {}),
    ).resolves.toEqual({ reviews: [] });
    expect(harness.inspection.sdk.calls).toHaveLength(0);
  });

  it("bounds metadata reads to 100 recent workspaces and returns at most 50, pending first", async () => {
    const { bb, harness } = host();
    await plugin(bb);
    for (let i = 1; i <= 105; i++) {
      const review = seedSnapshot(bb, `thread-${i}`, i);
      if (i === 1 || i === 6) seedComment(bb, review);
    }
    const result = (await harness.behavior.callRpc("recentReviews", {})) as {
      reviews: Array<{ threadId: string; pendingCount: number }>;
    };
    expect(result.reviews).toHaveLength(50);
    expect(result.reviews[0]).toMatchObject({
      threadId: "thread-6",
      pendingCount: 1,
    });
    expect(result.reviews[1]?.threadId).toBe("thread-105");
    expect(result.reviews[49]?.threadId).toBe("thread-57");
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(100);
    expect(harness.inspection.sdk.callsTo("threads.list")).toHaveLength(0);
  });

  it.each([
    { status: 503, code: "unavailable" },
    { status: 404, code: "route_not_found" },
  ])(
    "surfaces SDK failure $code instead of disguising it as an empty list",
    async (failure) => {
      const { bb, harness } = host();
      await plugin(bb);
      seedSnapshot(bb, "thread-error", 1);
      harness.sdk.stub("threads.get", async () => {
        throw Object.assign(new Error("Server unavailable"), failure);
      });
      await expect(
        harness.behavior.callRpc("recentReviews", {}),
      ).rejects.toThrow("Server unavailable");
    },
  );
});

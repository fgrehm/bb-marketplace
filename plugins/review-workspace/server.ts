import { createHash, randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { runRecentCommits } from "./lib/git-log";
import { normalizeChangeKind } from "./lib/utils";
import {
  ENTITY_CONTENT_MAX_CHARS,
  runEntityDiff,
  runEntityImpact,
} from "./lib/sem";
import type { SemEntityChange } from "./lib/sem";

const fileShape = z
  .object({
    path: z.string(),
    previousPath: z.string().nullable(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    binary: z.boolean(),
    patch: z.string(),
    truncated: z.boolean(),
  })
  .strict();
const suggestionShape = z
  .object({ id: z.string(), rationale: z.string(), createdAt: z.number() })
  .strict();
const annotationShape = z
  .object({
    id: z.string(),
    filePath: z.string(),
    side: z.enum(["old", "new"]),
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    body: z.string(),
    createdAt: z.number(),
    sentAt: z.number().nullable(),
    resolvedAt: z.number().nullable(),
    author: z.enum(["human", "agent"]),
    parentId: z.string().nullable(),
    fileLevel: z.boolean(),
    carriedFromAnnotationId: z.string().nullable(),
    resolutionSuggestion: suggestionShape.nullable(),
  })
  .strict();
export const reviewTargetShape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommitted") }).strict(),
  z
    .object({ type: z.literal("commit"), sha: z.string().min(7).max(64) })
    .strict(),
  z
    .object({
      type: z.literal("branch_committed"),
      mergeBaseBranch: z.string().min(1).max(200),
    })
    .strict(),
]);
export type ReviewTarget = z.infer<typeof reviewTargetShape>;

function encodeTarget(target: ReviewTarget): string {
  if (target.type === "commit") return `commit:${target.sha}`;
  if (target.type === "branch_committed")
    return `branch_committed:${target.mergeBaseBranch}`;
  return "uncommitted";
}

function decodeTarget(value: string): ReviewTarget {
  const [type, rest] = value.split(":");
  if (type === "commit" && rest) return { type: "commit", sha: rest };
  if (type === "branch_committed" && rest)
    return { type: "branch_committed", mergeBaseBranch: rest };
  return { type: "uncommitted" };
}

type PatchTarget =
  | { type: "uncommitted" }
  | { type: "commit"; sha: string }
  | { type: "branch_committed"; mergeBaseBranch: string };

function describeTarget(target: ReviewTarget): string {
  if (target.type === "commit") return `commit ${target.sha.slice(0, 10)}`;
  if (target.type === "branch_committed")
    return `committed vs ${target.mergeBaseBranch}`;
  return "uncommitted changes";
}

const reviewShape = z
  .object({
    id: z.string(),
    threadId: z.string(),
    snapshot: z.string(),
    createdAt: z.number(),
    target: reviewTargetShape,
    files: z.array(fileShape),
    annotations: z.array(annotationShape),
    viewedPaths: z.array(z.string()),
    summary: z.string().nullable(),
  })
  .strict();
const reviewSummaryShape = reviewShape
  .pick({ id: true, threadId: true, snapshot: true, createdAt: true })
  .extend({
    target: reviewTargetShape,
    fileCount: z.number().int(),
    annotationCount: z.number().int(),
    unresolvedCount: z.number().int(),
    viewedCount: z.number().int(),
  });

export const rpcContract = defineRpcContract({
  review: {
    input: z
      .object({
        threadId: z.string().min(1),
        reviewId: z.string().uuid().optional(),
      })
      .strict(),
    output: z.object({ review: reviewShape.nullable() }),
  },
  revisions: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ revisions: z.array(reviewSummaryShape) }),
  },
  refreshReview: {
    input: z
      .object({
        threadId: z.string().min(1),
        target: reviewTargetShape.optional(),
      })
      .strict(),
    output: z.object({ review: reviewShape }),
  },
  markFileViewed: {
    input: z
      .object({
        reviewId: z.string().uuid(),
        filePath: z.string().min(1),
        viewed: z.boolean(),
      })
      .strict(),
    output: z.object({ viewed: z.boolean(), viewedCount: z.number().int() }),
  },
  reviewFileContents: {
    input: z
      .object({ reviewId: z.string().uuid(), filePath: z.string().min(1) })
      .strict(),
    output: z.object({
      old: z
        .object({ path: z.string(), content: z.string() })
        .strict()
        .nullable(),
      new: z
        .object({ path: z.string(), content: z.string() })
        .strict()
        .nullable(),
    }),
  },
  addAnnotation: {
    input: z
      .object({
        reviewId: z.string().uuid(),
        filePath: z.string().min(1),
        side: z.enum(["old", "new"]).optional(),
        startLine: z.number().int().nonnegative().optional(),
        endLine: z.number().int().nonnegative().optional(),
        body: z.string().min(1).max(1000),
        parentId: z.string().uuid().optional(),
        fileLevel: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ annotation: annotationShape }),
  },
  removeAnnotation: {
    input: z.object({ annotationId: z.string().uuid() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  resolveAnnotation: {
    input: z
      .object({ annotationId: z.string().uuid(), resolved: z.boolean() })
      .strict(),
    output: z.object({ resolvedAt: z.number().nullable() }),
  },
  carryForward: {
    input: z
      .object({
        sourceReviewId: z.string().uuid(),
        targetReviewId: z.string().uuid(),
        annotationIds: z.array(z.string().uuid()).max(100),
      })
      .strict(),
    output: z.object({ annotations: z.array(annotationShape) }),
  },
  decideResolutionSuggestion: {
    input: z
      .object({ suggestionId: z.string().uuid(), accept: z.boolean() })
      .strict(),
    output: z.object({ resolvedAt: z.number().nullable() }),
  },
  setReviewSummary: {
    input: z
      .object({ reviewId: z.string().uuid(), summary: z.string().max(2000) })
      .strict(),
    output: z.object({ summary: z.string().nullable() }),
  },

  // EXPERIMENTAL: transitive dependents/tests for a summarized entity.
  entityImpact: {
    input: z
      .object({
        reviewId: z.string().uuid(),
        entityId: z.string().min(1),
      })
      .strict(),
    output: z.object({
      status: z.enum(["ok", "unavailable"]),
      reason: z.string().nullable(),
      dependents: z.array(
        z
          .object({
            entityId: z.string(),
            file: z.string(),
            lines: z.tuple([z.number().int(), z.number().int()]),
            name: z.string(),
            type: z.string(),
          })
          .strict(),
      ),
      tests: z.array(
        z
          .object({
            entityId: z.string(),
            file: z.string(),
            lines: z.tuple([z.number().int(), z.number().int()]),
            name: z.string(),
            type: z.string(),
          })
          .strict(),
      ),
      total: z.number().int(),
      depth: z.number().int(),
    }),
  },

  // EXPERIMENTAL: aggregated entity summary over the whole revision.
  // EXPERIMENTAL: aggregated entity summary across the revision, ordered by
  // review priority (structural churn first). One sem run per revision,
  // shared with concurrent callers. Rows carry capped per-entity content so
  // the dedicated entities view can render before/after diffs standalone.
  entitySummary: {
    input: z.object({ reviewId: z.string().uuid() }).strict(),
    output: z.object({
      status: z.enum(["ok", "unavailable"]),
      reason: z.string().nullable(),
      changes: z.array(
        z
          .object({
            entityId: z.string(),
            changeType: z.enum([
              "added",
              "modified",
              "deleted",
              "moved",
              "renamed",
              "reordered",
            ]),
            entityType: z.string(),
            entityName: z.string(),
            filePath: z.string(),
            startLine: z.number().int().nullable(),
            endLine: z.number().int().nullable(),
            structuralChange: z.boolean().nullable(),
            beforeContent: z.string().nullable().optional(),
            afterContent: z.string().nullable().optional(),
          })
          .strict(),
      ),
    }),
  },

  // EXPERIMENTAL: recent commits of the thread's environment checkout, for
  // the review target picker (pick a commit instead of pasting a sha).
  recentCommits: {
    input: z
      .object({
        threadId: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    output: z.object({
      status: z.enum(["ok", "unavailable"]),
      reason: z.string().nullable(),
      commits: z.array(
        z
          .object({
            sha: z.string(),
            short: z.string(),
            date: z.string(),
            subject: z.string(),
            author: z.string(),
          })
          .strict(),
      ),
    }),
  },

  clearPreviousReviews: {
    input: z
      .object({ threadId: z.string().min(1), keepReviewId: z.string().uuid() })
      .strict(),
    output: z.object({ deletedCount: z.number().int().nonnegative() }),
  },
  sendBatch: {
    input: z
      .object({
        reviewId: z.string().uuid(),
        annotationIds: z.array(z.string().uuid()).max(100),
      })
      .strict(),
    output: z.object({
      sentAt: z.number(),
      count: z.number().int().nonnegative(),
    }),
  },
});

type Review = z.infer<typeof reviewShape>;
type Annotation = z.infer<typeof annotationShape>;

const DIFF_MAX_CHARS = 2_000;
const DIFF_CONTEXT_LINES = 2;

type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
};

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (current && /^[ +-\\]/.test(line)) {
      current.lines.push(line);
    }
  }
  return hunks;
}

/**
 * Build a minimal diff for the batch: for each commented file, only the hunk
 * lines that fall inside a commented range (plus a couple of context lines).
 */
function buildDiff(review: Review, annotations: Annotation[]): string {
  const byPath = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    const list = byPath.get(annotation.filePath) ?? [];
    list.push(annotation);
    byPath.set(annotation.filePath, list);
  }
  const parts: string[] = [];
  for (const file of review.files) {
    const commented = byPath.get(file.path);
    if (!commented || file.binary) continue;
    const range = (line: number, side: "old" | "new") =>
      commented.some((annotation) =>
        annotation.side === side
          ? line >= annotation.startLine - DIFF_CONTEXT_LINES &&
            line <= annotation.endLine + DIFF_CONTEXT_LINES
          : false,
      );
    const blocks: string[] = [];
    for (const hunk of parseHunks(file.patch)) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const kept: string[] = [];
      for (const line of hunk.lines) {
        const marker = line[0];
        const keep =
          marker === "+"
            ? range(newLine, "new")
            : marker === "-"
              ? range(oldLine, "old")
              : marker === "\\"
                ? false
                : range(newLine, "new") || range(oldLine, "old");
        if (keep) kept.push(line);
        if (marker !== "+") oldLine++;
        if (marker !== "-") newLine++;
      }
      if (kept.length) blocks.push(`@@ ${file.path} @@\n${kept.join("\n")}`);
    }
    if (blocks.length) parts.push(blocks.join("\n"));
  }
  const diff = parts.join("\n");
  return diff.length <= DIFF_MAX_CHARS
    ? diff
    : `${diff.slice(0, DIFF_MAX_CHARS)}\n(diff truncated)`;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    // NOTE: statements 0-38 are frozen - they hash-match the running daemon's
    // recorded migrations; the guard refuses any change to an applied index.
    // Schema changes must be appended below.
    `CREATE TABLE IF NOT EXISTS system_samples (timestamp INTEGER PRIMARY KEY, cpu_usage_percent REAL NOT NULL, memory_used_fraction REAL NOT NULL, disk_used_fraction REAL NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS review_workspaces (parent_thread_id TEXT PRIMARY KEY, review_thread_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`,
    `ALTER TABLE review_workspaces ADD COLUMN summary_sent_at INTEGER`,
    `CREATE TABLE IF NOT EXISTS review_revisions (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS review_files (review_id TEXT NOT NULL, path TEXT NOT NULL, previous_path TEXT, status TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL, binary INTEGER NOT NULL, patch TEXT NOT NULL, truncated INTEGER NOT NULL, PRIMARY KEY (review_id, path))`,
    `CREATE TABLE IF NOT EXISTS review_annotations (id TEXT PRIMARY KEY, review_id TEXT NOT NULL, file_path TEXT NOT NULL, side TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, batch_id TEXT)`,
    `ALTER TABLE review_annotations ADD COLUMN resolved_at INTEGER`,
    `ALTER TABLE review_annotations ADD COLUMN carried_from_annotation_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS review_annotations_carried_once ON review_annotations (review_id, carried_from_annotation_id) WHERE carried_from_annotation_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS review_resolution_suggestions (id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL UNIQUE, rationale TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS review_viewed_files (review_id TEXT NOT NULL, path TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY (review_id, path))`,
    `CREATE INDEX IF NOT EXISTS review_viewed_files_review_id ON review_viewed_files (review_id)`,
    `ALTER TABLE review_files ADD COLUMN old_content TEXT`,
    `ALTER TABLE review_files ADD COLUMN new_content TEXT`,
    `ALTER TABLE review_annotations ADD COLUMN summary TEXT`,
    `ALTER TABLE review_annotations ADD COLUMN rationale TEXT`,
    `UPDATE review_annotations SET summary = body WHERE summary IS NULL`,
    `CREATE TABLE IF NOT EXISTS review_review_summaries (review_id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS review_file_notes (review_id TEXT NOT NULL, path TEXT NOT NULL, summary TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (review_id, path))`,
    `UPDATE review_annotations SET body = body || char(10, 10) || rationale WHERE rationale IS NOT NULL`,
    // Pre-release rebuild: nothing has shipped yet, so the review schema is
    // wiped and recreated in its latest form (with FKs, target, author,
    // thread replies, and file-level anchoring). Data wipe is intentional.
    `ALTER TABLE review_revisions ADD COLUMN target TEXT NOT NULL DEFAULT 'uncommitted'`,
    `ALTER TABLE review_annotations ADD COLUMN author TEXT NOT NULL DEFAULT 'human'`,
    `DROP TABLE IF EXISTS review_resolution_suggestions`,
    `DROP TABLE IF EXISTS review_annotations`,
    `DROP TABLE IF EXISTS review_viewed_files`,
    `DROP TABLE IF EXISTS review_file_notes`,
    `DROP TABLE IF EXISTS review_review_summaries`,
    `DROP TABLE IF EXISTS review_files`,
    `DROP TABLE IF EXISTS review_revisions`,
    `CREATE TABLE review_revisions (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, target TEXT NOT NULL DEFAULT 'uncommitted')`,
    `CREATE TABLE review_files (review_id TEXT NOT NULL, path TEXT NOT NULL, previous_path TEXT, status TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL, binary INTEGER NOT NULL, patch TEXT NOT NULL, truncated INTEGER NOT NULL, old_content TEXT, new_content TEXT, PRIMARY KEY (review_id, path), FOREIGN KEY (review_id) REFERENCES review_revisions (id) ON DELETE CASCADE)`,
    `CREATE TABLE review_annotations (id TEXT PRIMARY KEY, review_id TEXT NOT NULL, file_path TEXT NOT NULL, side TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, batch_id TEXT, resolved_at INTEGER, carried_from_annotation_id TEXT, summary TEXT, rationale TEXT, author TEXT NOT NULL DEFAULT 'human', FOREIGN KEY (review_id) REFERENCES review_revisions (id) ON DELETE CASCADE)`,
    `CREATE UNIQUE INDEX review_annotations_carried_once ON review_annotations (review_id, carried_from_annotation_id) WHERE carried_from_annotation_id IS NOT NULL`,
    `CREATE TABLE review_resolution_suggestions (id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL UNIQUE, rationale TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, FOREIGN KEY (annotation_id) REFERENCES review_annotations (id) ON DELETE CASCADE)`,
    `CREATE TABLE review_viewed_files (review_id TEXT NOT NULL, path TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY (review_id, path), FOREIGN KEY (review_id) REFERENCES review_revisions (id) ON DELETE CASCADE)`,
    `CREATE INDEX review_viewed_files_review_id ON review_viewed_files (review_id)`,
    `CREATE TABLE review_review_summaries (review_id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (review_id) REFERENCES review_revisions (id) ON DELETE CASCADE)`,
    `CREATE TABLE review_file_notes (review_id TEXT NOT NULL, path TEXT NOT NULL, summary TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (review_id, path), FOREIGN KEY (review_id) REFERENCES review_revisions (id) ON DELETE CASCADE)`,
    `ALTER TABLE review_annotations ADD COLUMN parent_id TEXT`,
    // Append-only (new): EXPERIMENTAL cached entity-level diffs by sem. The
    // parent_id ALTER above was superseded by the rebuild, but its recorded
    // hash must stay untouched.
    // Append-only (new): file-level anchoring (experimental feature set).
    `ALTER TABLE review_annotations ADD COLUMN file_level INTEGER NOT NULL DEFAULT 0`,
    // Append-only (new): EXPERIMENTAL cached entity-level diffs by sem.
    `CREATE TABLE IF NOT EXISTS review_entities (review_id TEXT NOT NULL, path TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (review_id, path))`,
    // Append-only (new): rows created before reply propagation adopt their
    // root's file_level so reply anchors never surface as `path:0` labels.
    `UPDATE review_annotations SET file_level = COALESCE((SELECT root.file_level FROM review_annotations AS root WHERE root.id = review_annotations.parent_id), file_level) WHERE parent_id IS NOT NULL`,
  ]);
  db.pragma("foreign_keys = ON");

  function annotations(reviewId: string): Annotation[] {
    return db
      .prepare(
        "SELECT a.id, a.file_path, a.side, a.start_line, a.end_line, a.body, a.summary, a.rationale, a.created_at, a.sent_at, a.resolved_at, a.author, a.parent_id, a.file_level, a.carried_from_annotation_id, s.id AS suggestion_id, s.rationale AS suggestion_rationale, s.created_at AS suggestion_created_at FROM review_annotations a LEFT JOIN review_resolution_suggestions s ON s.annotation_id = a.id AND s.status = 'pending' WHERE a.review_id = ? ORDER BY a.created_at",
      )
      .all(reviewId)
      .map((row: any) => ({
        id: row.id,
        filePath: row.file_path,
        side: row.side,
        startLine: row.start_line,
        endLine: row.end_line,
        body: row.body,
        createdAt: row.created_at,
        sentAt: row.sent_at ?? null,
        resolvedAt: row.resolved_at ?? null,
        author: row.author === "agent" ? "agent" : "human",
        parentId: row.parent_id ?? null,
        fileLevel: Boolean(row.file_level),
        carriedFromAnnotationId: row.carried_from_annotation_id ?? null,
        resolutionSuggestion: row.suggestion_id
          ? {
              id: row.suggestion_id,
              rationale: row.suggestion_rationale,
              createdAt: row.suggestion_created_at,
            }
          : null,
      }));
  }
  function reviewSummary(reviewId: string): string | null {
    const row = db
      .prepare(
        "SELECT summary FROM review_review_summaries WHERE review_id = ?",
      )
      .get(reviewId) as { summary: string } | undefined;
    return row?.summary ?? null;
  }
  function viewedPaths(reviewId: string): string[] {
    return (
      db
        .prepare(
          "SELECT path FROM review_viewed_files WHERE review_id = ? ORDER BY path",
        )
        .all(reviewId) as Array<{ path: string }>
    ).map((row) => row.path);
  }
  function read(reviewId: string): Review | null {
    const revision = db
      .prepare(
        "SELECT id, thread_id, snapshot, created_at, target FROM review_revisions WHERE id = ?",
      )
      .get(reviewId) as any;
    if (!revision) return null;
    const files = db
      .prepare(
        "SELECT path, previous_path, status, additions, deletions, binary, patch, truncated FROM review_files WHERE review_id = ? ORDER BY path",
      )
      .all(reviewId)
      .map((row: any) => ({
        path: row.path,
        previousPath: row.previous_path ?? null,
        status: row.status,
        additions: row.additions,
        deletions: row.deletions,
        binary: Boolean(row.binary),
        patch: row.patch,
        truncated: Boolean(row.truncated),
      }));
    return {
      id: revision.id,
      threadId: revision.thread_id,
      snapshot: revision.snapshot,
      createdAt: revision.created_at,
      target: decodeTarget(revision.target),
      files,
      annotations: annotations(reviewId),
      viewedPaths: viewedPaths(reviewId),
      summary: reviewSummary(reviewId),
    };
  }
  function latest(threadId: string): Review | null {
    const row = db
      .prepare(
        "SELECT id FROM review_revisions WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(threadId) as any;
    return row ? read(row.id) : null;
  }

  function carryCommentsInternal(
    sourceReviewId: string,
    targetReviewId: string,
    annotationIds: string[],
  ): Annotation[] {
    const source = read(sourceReviewId);
    const target = read(targetReviewId);
    if (!source || !target) throw new Error("Review revision was not found.");
    if (latest(target.threadId)?.id !== targetReviewId)
      throw new Error(
        "Comments can only be carried to the latest review revision.",
      );
    const wanted = new Set(annotationIds);
    const requested = source.annotations.filter(
      (annotation) =>
        wanted.has(annotation.id) && annotation.resolvedAt === null,
    );
    if (requested.length !== wanted.size)
      throw new Error(
        "Only unresolved comments from the source revision may be carried forward.",
      );
    // Carry whole threads: a requested root brings its unresolved replies,
    // and a requested reply brings its root so context never orphans.
    const toCarry = new Map(requested.map((a) => [a.id, a]));
    for (const annotation of requested) {
      if (annotation.parentId) {
        const root = source.annotations.find(
          (a) => a.id === annotation.parentId,
        );
        if (root && !toCarry.has(root.id)) toCarry.set(root.id, root);
      }
    }
    for (const annotation of [...toCarry.values()]) {
      if (!annotation.parentId) {
        for (const reply of source.annotations) {
          if (
            reply.parentId === annotation.id &&
            reply.resolvedAt === null &&
            !toCarry.has(reply.id)
          )
            toCarry.set(reply.id, reply);
        }
      }
    }
    // Insert roots before replies so parent ids can be remapped.
    const ordered = [...toCarry.values()].sort((a, b) =>
      a.parentId === b.parentId ? 0 : a.parentId ? 1 : -1,
    );
    const insert = db.prepare(
      "INSERT OR IGNORE INTO review_annotations (id, review_id, file_path, side, start_line, end_line, body, created_at, author, parent_id, file_level, carried_from_annotation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const idRemap = new Map<string, string>();
    db.transaction(() => {
      for (const annotation of ordered) {
        const newId = randomUUID();
        idRemap.set(annotation.id, newId);
        insert.run(
          newId,
          targetReviewId,
          annotation.filePath,
          annotation.side,
          annotation.startLine,
          annotation.endLine,
          annotation.body,
          Date.now(),
          annotation.author,
          annotation.parentId
            ? (idRemap.get(annotation.parentId) ?? null)
            : null,
          Number(annotation.fileLevel),
          annotation.id,
        );
      }
    })();
    return annotations(targetReviewId);
  }

  function addAnnotationInternal(
    reviewId: string,
    input: {
      filePath: string;
      side?: "old" | "new";
      startLine?: number;
      endLine?: number;
      body: string;
      parentId?: string;
      fileLevel?: boolean;
    },
    author: "human" | "agent" = "human",
  ): Annotation {
    const review = read(reviewId);
    if (!review) throw new Error("Review revision was not found.");
    let parentId: string | null = null;
    let anchor: Annotation | undefined;
    if (input.parentId) {
      anchor = review.annotations.find(
        (annotation) => annotation.id === input.parentId,
      );
      if (!anchor) throw new Error("The comment to reply to was not found.");
      if (anchor.parentId)
        throw new Error(
          "Threads are limited to one top-level comment with replies.",
        );
      // Replies inherit the parent's anchor so the whole thread stays on line.
      parentId = anchor.id;
    } else if (!review.files.some((file) => file.path === input.filePath)) {
      throw new Error("The file is not part of this review revision.");
    }
    // File-level comments anchor to the whole file (startLine 0) instead of a
    // single line, so they stay threadable, resolvable, and sendable exactly
    // like line comments. Replies propagate the parent's anchor wholesale -
    // including file-level, so the whole thread renders/locates/sends as a
    // unit and reply anchors never surface as `path:0` line labels.
    const fileLevel = parentId
      ? Boolean(anchor!.fileLevel)
      : Boolean(input.fileLevel);
    const fallbackEnd = input.endLine ?? input.startLine ?? 0;
    const annotation: Annotation = {
      id: randomUUID(),
      filePath: anchor ? anchor.filePath : input.filePath,
      side: anchor ? anchor.side : (input.side ?? "new"),
      startLine: anchor
        ? anchor.startLine
        : fileLevel
          ? 0
          : input.startLine != null
            ? Math.min(input.startLine, fallbackEnd)
            : 0,
      endLine: anchor
        ? anchor.endLine
        : fileLevel
          ? 0
          : input.startLine != null
            ? Math.max(input.startLine, fallbackEnd)
            : 0,
      body: input.body.trim(),
      createdAt: Date.now(),
      sentAt: null,
      resolvedAt: null,
      author,
      parentId,
      fileLevel,
      carriedFromAnnotationId: null,
      resolutionSuggestion: null,
    };
    db.prepare(
      "INSERT INTO review_annotations (id, review_id, file_path, side, start_line, end_line, body, created_at, author, parent_id, file_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      annotation.id,
      reviewId,
      annotation.filePath,
      annotation.side,
      annotation.startLine,
      annotation.endLine,
      annotation.body,
      annotation.createdAt,
      author,
      annotation.parentId,
      Number(annotation.fileLevel),
    );
    return annotation;
  }

  async function refreshReviewImpl({
    threadId,
    target: targetInput,
  }: {
    threadId: string;
    target?: ReviewTarget;
  }): Promise<Review> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId)
      throw new Error("This thread has no environment.");
    const target: ReviewTarget = targetInput ?? { type: "uncommitted" };
    const listing = await bb.sdk.environments.diffFiles({
      environmentId: thread.environmentId,
      ...(target.type === "commit"
        ? { target: "commit" as const, sha: target.sha }
        : target.type === "branch_committed"
          ? {
              target: "branch_committed" as const,
              mergeBaseBranch: target.mergeBaseBranch,
            }
          : { target: "uncommitted" as const }),
    });
    if (listing.outcome !== "available")
      throw new Error(
        "message" in listing ? listing.message : listing.failure.message,
      );
    const paths = listing.files
      .filter((file) => !file.binary)
      .slice(0, 100)
      .map((file) => file.path);
    const patches = paths.length
      ? await bb.sdk.environments.diffPatch({
          environmentId: thread.environmentId,
          target: {
            type: target.type,
            ...(target.type === "commit"
              ? { sha: target.sha }
              : target.type === "branch_committed"
                ? { mergeBaseBranch: target.mergeBaseBranch }
                : {}),
          } as PatchTarget,
          paths,
        })
      : { outcome: "available" as const, patches: [] };
    if (patches.outcome !== "available")
      throw new Error(
        "message" in patches ? patches.message : patches.failure.message,
      );
    const files = listing.files.slice(0, 100);
    const patchByPath = new Map(
      patches.patches.map((patch) => [patch.path, patch]),
    );
    const fileContents = await Promise.all(
      files.map(async (file) => {
        if (
          file.binary ||
          file.loadMode === "too_large" ||
          patchByPath.get(file.path)?.truncated
        )
          return { file, old: null, new: null };
        const readSide = async (side: "old" | "new", path: string) => {
          try {
            const result = await bb.sdk.environments.diffFile({
              environmentId: thread.environmentId!,
              path,
              side,
              ...(target.type === "commit"
                ? { target: "commit" as const, sha: target.sha }
                : target.type === "branch_committed"
                  ? {
                      target: "branch_committed" as const,
                      mergeBaseRef: target.mergeBaseBranch,
                    }
                  : { target: "uncommitted" as const }),
            });
            return {
              path: result.path,
              content:
                result.contentEncoding === "base64"
                  ? Buffer.from(result.content, "base64").toString("utf8")
                  : result.content,
            };
          } catch {
            return null;
          }
        };
        const changeKind = normalizeChangeKind(file.changeKind);
        const [old, newer] = await Promise.all([
          changeKind === "added"
            ? Promise.resolve(null)
            : readSide("old", file.previousPath ?? file.path),
          changeKind === "deleted"
            ? Promise.resolve(null)
            : readSide("new", file.path),
        ]);
        return { file, old, new: newer };
      }),
    );
    const snapshot = createHash("sha256")
      .update(encodeTarget(target))
      .update(JSON.stringify(listing.files))
      .update(patches.patches.map((p) => p.patch).join("\n"))
      .update(
        JSON.stringify(
          fileContents.map(({ file, old, new: newer }) => ({
            path: file.path,
            old,
            new: newer,
          })),
        ),
      )
      .digest("hex");
    const previous = latest(threadId);
    if (previous?.snapshot === snapshot) return previous;
    const id = randomUUID();
    const createdAt = Date.now();
    const insertRevision = db.prepare(
      "INSERT INTO review_revisions (id, thread_id, snapshot, created_at, target) VALUES (?, ?, ?, ?, ?)",
    );
    const insertFile = db.prepare(
      "INSERT INTO review_files (review_id, path, previous_path, status, additions, deletions, binary, patch, truncated, old_content, new_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      insertRevision.run(
        id,
        threadId,
        snapshot,
        createdAt,
        encodeTarget(target),
      );
      for (const { file, old, new: newer } of fileContents) {
        const patch = patchByPath.get(file.path);
        insertFile.run(
          id,
          file.path,
          file.previousPath,
          normalizeChangeKind(file.changeKind),
          file.additions,
          file.deletions,
          Number(file.binary),
          patch?.patch ?? "",
          Number(patch?.truncated ?? false),
          old?.content ?? null,
          newer?.content ?? null,
        );
      }
      // Auto-carry open feedback into the new snapshot via the same shared
      // carry logic used for cross-revision imports: unresolved comment
      // threads (with parent remapping and author preserved) plus the review
      // note. Copies keep the old revision immutable.
      if (previous) {
        carryCommentsInternal(
          previous.id,
          id,
          previous.annotations
            .filter((candidate) => candidate.resolvedAt === null)
            .map((candidate) => candidate.id),
        );
        const previousNote = reviewSummary(previous.id);
        if (previousNote)
          db.prepare(
            "INSERT INTO review_review_summaries (review_id, summary, updated_at) VALUES (?, ?, ?)",
          ).run(id, previousNote, createdAt);
      }
    })();
    return read(id)!;
  }

  // EXPERIMENTAL: entity-level changes for a whole review revision, computed
  // lazily with a single sem CLI run over the revision's immutable snapshot
  // contents and cached per (revision, file). sem never touches git, so
  // results are identical across threads reviewing the same snapshot.
  type EntityRevisionResult = {
    status: "ok" | "unavailable";
    reason: string | null;
    byPath: Map<string, SemEntityChange[]>;
  };

  // Concurrent callers (summary + impact lookups) share one computation.
  const inFlightEntityRuns = new Map<string, Promise<EntityRevisionResult>>();

  async function computeEntitiesForRevision(
    reviewId: string,
  ): Promise<EntityRevisionResult> {
    const review = read(reviewId);
    if (!review) throw new Error("Review revision was not found.");
    const textFiles = review.files.filter((file) => !file.binary);
    // Snapshot contents live in review_files.old_content / new_content.
    // Computing from the immutable stored blobs keeps results identical
    // across refreshes and keeps sem entirely off git.
    const contentQuery = db.prepare(
      "SELECT old_content, new_content FROM review_files WHERE review_id = ? AND path = ?",
    );
    const upsertEntity = db.prepare(
      "INSERT OR REPLACE INTO review_entities (review_id, path, payload, updated_at) VALUES (?, ?, ?, ?)",
    );
    const readCache = (): EntityRevisionResult | null => {
      const rows = db
        .prepare(
          "SELECT path, payload FROM review_entities WHERE review_id = ?",
        )
        .all(reviewId) as Array<{ path: string; payload: string }>;
      const payloads = new Map<
        string,
        | { status: "ok"; changes: SemEntityChange[] }
        | { status: "unavailable"; reason: string }
      >();
      for (const row of rows) {
        try {
          payloads.set(row.path, JSON.parse(row.payload));
        } catch {
          return null;
        }
      }
      // A partial cache (a file without a row, e.g. written by an older
      // plugin version) triggers recomputation.
      if (textFiles.some((file) => !payloads.has(file.path))) return null;
      const unavailable = textFiles
        .map((file) => payloads.get(file.path))
        .find((payload) => payload?.status === "unavailable");
      if (unavailable) {
        return {
          status: "unavailable",
          reason: unavailable.reason,
          byPath: new Map(),
        };
      }
      const byPath = new Map<string, SemEntityChange[]>();
      for (const file of textFiles) {
        byPath.set(
          file.path,
          (payloads.get(file.path) as { changes: SemEntityChange[] }).changes ??
            [],
        );
      }
      return { status: "ok", reason: null, byPath };
    };
    const cached = readCache();
    if (cached) return cached;
    const inputs = textFiles.map((file) => {
      const contents = contentQuery.get(review.id, file.path) as
        { old_content: string | null; new_content: string | null } | undefined;
      return {
        filePath: file.path,
        beforeContent: contents?.old_content ?? null,
        afterContent: contents?.new_content ?? null,
      };
    });
    const result = await runEntityDiff(inputs);
    if (result.status === "ok") {
      // Backfill per-entity content from the stored snapshot files when sem
      // omits it (oversized per sem's own cap, granular chunks, ...). Only
      // modified/reordered entities are safe: added entities have no old
      // range and deleted entities report new-side numbers that do not exist
      // in the new content.
      const snapshot = new Map<
        string,
        { old: string | null; new: string | null }
      >();
      for (const file of textFiles) {
        const row = contentQuery.get(review.id, file.path) as
          | { old_content: string | null; new_content: string | null }
          | undefined;
        snapshot.set(file.path, {
          old: row?.old_content ?? null,
          new: row?.new_content ?? null,
        });
      }
      const sliceContent = (
        content: string | null,
        start: number | null,
        end: number | null,
      ): string | null => {
        if (content == null || start == null || start < 1) return null;
        const fileLines = content.split("\n");
        const lo = start - 1;
        const hi = Math.min(fileLines.length, end ?? start);
        if (hi <= lo) return null;
        const slice = fileLines.slice(lo, hi).join("\n");
        return slice.length > ENTITY_CONTENT_MAX_CHARS ? null : slice;
      };
      for (const change of result.changes) {
        if (
          change.beforeContent == null &&
          (change.changeType === "modified" ||
            change.changeType === "reordered")
        ) {
          change.beforeContent = sliceContent(
            snapshot.get(change.filePath)?.old ?? null,
            change.oldStartLine,
            change.oldEndLine,
          );
        }
        if (
          change.afterContent == null &&
          (change.changeType === "modified" ||
            change.changeType === "reordered")
        ) {
          change.afterContent = sliceContent(
            snapshot.get(change.filePath)?.new ?? null,
            change.startLine,
            change.endLine,
          );
        }
      }
    }
    const perPath = new Map<string, SemEntityChange[]>();
    if (result.status === "ok") {
      for (const change of result.changes) {
        const list = perPath.get(change.filePath) ?? [];
        list.push(change);
        perPath.set(change.filePath, list);
      }
    }
    const now = Date.now();
    db.transaction(() => {
      for (const file of textFiles) {
        const pathChanges =
          result.status === "ok" ? (perPath.get(file.path) ?? []) : [];
        const payload =
          result.status === "ok"
            ? { status: "ok" as const, changes: pathChanges }
            : { status: "unavailable" as const, reason: result.reason };
        upsertEntity.run(review.id, file.path, JSON.stringify(payload), now);
      }
    })();
    return {
      status: result.status,
      reason: result.status === "ok" ? null : result.reason,
      byPath: result.status === "ok" ? perPath : new Map(),
    };
  }

  function entitiesForRevision(
    reviewId: string,
  ): Promise<EntityRevisionResult> {
    const inFlight = inFlightEntityRuns.get(reviewId);
    if (inFlight) return inFlight;
    const run = computeEntitiesForRevision(reviewId).finally(() => {
      inFlightEntityRuns.delete(reviewId);
    });
    inFlightEntityRuns.set(reviewId, run);
    return run;
  }

  // Review-priority order for the summary: structural churn first
  // (deleted/moved/renamed are highest risk), then modifications, then
  // additions, then cosmetic-only reordering.
  const CHANGE_PRIORITY: Record<string, number> = {
    deleted: 0,
    moved: 0,
    renamed: 0,
    reordered: 1,
    modified: 1,
    added: 2,
  };

  bb.rpc.register(rpcContract, {
    review({ threadId, reviewId }) {
      const review = reviewId ? read(reviewId) : latest(threadId);
      return { review: review?.threadId === threadId ? review : null };
    },
    revisions({ threadId }) {
      return {
        revisions: db
          .prepare(
            `SELECT r.id, r.thread_id, r.snapshot, r.created_at, r.target, COUNT(DISTINCT f.path) AS file_count, COUNT(DISTINCT a.id) AS annotation_count, COUNT(DISTINCT CASE WHEN a.resolved_at IS NULL AND a.id IS NOT NULL THEN a.id END) AS unresolved_count, COUNT(DISTINCT v.path) AS viewed_count FROM review_revisions r LEFT JOIN review_files f ON f.review_id = r.id LEFT JOIN review_annotations a ON a.review_id = r.id LEFT JOIN review_viewed_files v ON v.review_id = r.id WHERE r.thread_id = ? GROUP BY r.id ORDER BY r.created_at DESC, r.rowid DESC`,
          )
          .all(threadId)
          .map((row: any) => ({
            id: row.id,
            threadId: row.thread_id,
            snapshot: row.snapshot,
            createdAt: row.created_at,
            target: decodeTarget(row.target),
            fileCount: row.file_count,
            annotationCount: Number(row.annotation_count),
            unresolvedCount: Number(row.unresolved_count ?? 0),
            viewedCount: Number(row.viewed_count ?? 0),
          })),
      };
    },
    markFileViewed({ reviewId, filePath, viewed }) {
      const review = read(reviewId);
      if (!review) throw new Error("Review revision was not found.");
      if (!review.files.some((file) => file.path === filePath))
        throw new Error("The file is not part of this review revision.");
      if (viewed) {
        db.prepare(
          "INSERT INTO review_viewed_files (review_id, path, viewed_at) VALUES (?, ?, ?) ON CONFLICT(review_id, path) DO UPDATE SET viewed_at = excluded.viewed_at",
        ).run(reviewId, filePath, Date.now());
      } else {
        db.prepare(
          "DELETE FROM review_viewed_files WHERE review_id = ? AND path = ?",
        ).run(reviewId, filePath);
      }
      return {
        viewed,
        viewedCount: viewedPaths(reviewId).length,
      };
    },
    reviewFileContents({ reviewId, filePath }) {
      const review = read(reviewId);
      if (!review) throw new Error("Review revision was not found.");
      if (!review.files.some((file) => file.path === filePath))
        throw new Error("The file is not part of this review revision.");
      const row = db
        .prepare(
          "SELECT previous_path, old_content, new_content FROM review_files WHERE review_id = ? AND path = ?",
        )
        .get(reviewId, filePath) as
        | {
            previous_path: string | null;
            old_content: string | null;
            new_content: string | null;
          }
        | undefined;
      if (!row)
        throw new Error("The file is not part of this review revision.");
      return {
        old:
          row.old_content === null
            ? null
            : {
                path: row.previous_path ?? filePath,
                content: row.old_content,
              },
        new:
          row.new_content === null
            ? null
            : { path: filePath, content: row.new_content },
      };
    },
    async refreshReview(input) {
      return { review: await refreshReviewImpl(input) };
    },
    async recentCommits({ threadId, limit }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread?.environmentId)
        return {
          status: "unavailable" as const,
          reason: "This thread has no environment.",
          commits: [],
        };
      const env = await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });
      if (!env?.path || !env.isGitRepo)
        return {
          status: "unavailable" as const,
          reason: "The review target needs a git checkout.",
          commits: [],
        };
      try {
        return {
          status: "ok" as const,
          reason: null,
          commits: await runRecentCommits(env.path, limit ?? 15),
        };
      } catch (cause) {
        return {
          status: "unavailable" as const,
          reason:
            cause instanceof Error ? cause.message : "git log failed to run",
          commits: [],
        };
      }
    },
    addAnnotation(input) {
      return { annotation: addAnnotationInternal(input.reviewId, input) };
    },
    setReviewSummary({ reviewId, summary }) {
      const review = read(reviewId);
      if (!review) throw new Error("Review revision was not found.");
      const text = summary.trim();
      if (text) {
        db.prepare(
          "INSERT INTO review_review_summaries (review_id, summary, updated_at) VALUES (?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at",
        ).run(reviewId, text, Date.now());
      } else {
        db.prepare(
          "DELETE FROM review_review_summaries WHERE review_id = ?",
        ).run(reviewId);
      }
      return { summary: text || null };
    },
    // EXPERIMENTAL: entity-level diff outline. Cached per (revision, file);
    // computed with sem from the immutable snapshot contents (via sem's stdin
    // mode), never from git, so results stay identical across refreshes.
    // EXPERIMENTAL: aggregated entity summary across the revision,
    // ordered by review priority (structural churn first). One sem run
    // per revision, shared with concurrent callers.
    async entitySummary({ reviewId }) {
      const review = read(reviewId);
      if (!review) throw new Error("Review revision was not found.");
      const { status, reason, byPath } = await entitiesForRevision(reviewId);
      const changes = review.files
        .filter((file) => !file.binary)
        .flatMap((file) => byPath.get(file.path) ?? []);
      changes.sort((a, b) => {
        const priority =
          (CHANGE_PRIORITY[a.changeType] ?? 3) -
          (CHANGE_PRIORITY[b.changeType] ?? 3);
        if (priority !== 0) return priority;
        return (
          a.filePath.localeCompare(b.filePath) ||
          (a.startLine ?? 0) - (b.startLine ?? 0)
        );
      });
      return {
        status:
          changes.length || status === "ok"
            ? ("ok" as const)
            : ("unavailable" as const),
        reason: status === "unavailable" && !changes.length ? reason : null,
        changes: changes.map((change) => ({
          entityId: change.entityId,
          changeType: change.changeType,
          entityType: change.entityType,
          entityName: change.entityName,
          filePath: change.filePath,
          startLine: change.startLine,
          endLine: change.endLine,
          structuralChange: change.structuralChange,
          beforeContent: change.beforeContent ?? null,
          afterContent: change.afterContent ?? null,
        })),
      };
    },

    // EXPERIMENTAL: transitive dependents/tests for an outlined entity via
    // `sem impact` run against the environment checkout root.
    async entityImpact({ reviewId, entityId }) {
      const review = read(reviewId);
      if (!review) throw new Error("Review revision was not found.");
      const rows = db
        .prepare("SELECT payload FROM review_entities WHERE review_id = ?")
        .all(reviewId) as Array<{ payload: string }>;
      let entity: SemEntityChange | undefined;
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload) as {
            status: string;
            changes: SemEntityChange[];
          };
          if (payload.status !== "ok") continue;
          const found = payload.changes.find(
            (change) => change.entityId === entityId,
          );
          if (found) {
            entity = found;
            break;
          }
        } catch {
          /* skip malformed cached rows */
        }
      }
      if (!entity)
        throw new Error("The entity is not part of this review revision.");
      try {
        const thread = await bb.sdk.threads.get({ threadId: review.threadId });
        if (!thread?.environmentId)
          return {
            status: "unavailable" as const,
            reason: "The review revision has no environment to analyze.",
            dependents: [],
            tests: [],
            total: 0,
            depth: 0,
          };
        const env = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        if (!env?.path || !env.isGitRepo)
          return {
            status: "unavailable" as const,
            reason: "sem impact needs a git checkout of the reviewed code.",
            dependents: [],
            tests: [],
            total: 0,
            depth: 0,
          };
        const result = await runEntityImpact(
          entity.entityId,
          entity.entityName,
          entity.filePath,
          env.path,
          entity.entityType,
        );
        if (result.status === "ok") {
          return { ...result, reason: null };
        }
        return {
          status: "unavailable" as const,
          reason: result.reason,
          dependents: [],
          tests: [],
          total: 0,
          depth: 0,
        };
      } catch (cause) {
        return {
          status: "unavailable" as const,
          reason:
            cause instanceof Error ? cause.message : "sem impact failed to run",
          dependents: [],
          tests: [],
          total: 0,
          depth: 0,
        };
      }
    },
    removeAnnotation({ annotationId }) {
      const replies = db
        .prepare(
          "SELECT COUNT(*) AS n FROM review_annotations WHERE parent_id = ?",
        )
        .get(annotationId) as { n: number };
      if (replies.n > 0)
        throw new Error(
          "Comment has replies and cannot be removed on its own.",
        );
      db.prepare(
        "DELETE FROM review_annotations WHERE id = ? AND sent_at IS NULL",
      ).run(annotationId);
      return { ok: true as const };
    },
    resolveAnnotation({ annotationId, resolved }) {
      const resolvedAt = resolved ? Date.now() : null;
      const result = db
        .prepare("UPDATE review_annotations SET resolved_at = ? WHERE id = ?")
        .run(resolvedAt, annotationId);
      if (result.changes !== 1) throw new Error("Comment was not found.");
      // Resolving (or reopening) a top-level comment resolves the whole thread.
      db.prepare(
        "UPDATE review_annotations SET resolved_at = ? WHERE parent_id = ?",
      ).run(resolvedAt, annotationId);
      return { resolvedAt };
    },
    carryForward({ sourceReviewId, targetReviewId, annotationIds }) {
      const source = read(sourceReviewId);
      const target = read(targetReviewId);
      if (!source || !target || source.threadId !== target.threadId)
        throw new Error("Review revisions must belong to the same thread.");
      return {
        annotations: carryCommentsInternal(
          sourceReviewId,
          targetReviewId,
          annotationIds,
        ).filter(
          (annotation) =>
            annotation.carriedFromAnnotationId !== null &&
            new Set(annotationIds).has(annotation.carriedFromAnnotationId),
        ),
      };
    },
    clearPreviousReviews({ threadId, keepReviewId }) {
      const keep = read(keepReviewId);
      if (!keep || keep.threadId !== threadId)
        throw new Error("The review to keep was not found in this thread.");
      const ids = db
        .prepare(
          "SELECT id FROM review_revisions WHERE thread_id = ? AND id != ?",
        )
        .all(threadId, keepReviewId) as Array<{ id: string }>;
      db.transaction(() => {
        for (const { id } of ids) {
          db.prepare(
            "DELETE FROM review_resolution_suggestions WHERE annotation_id IN (SELECT id FROM review_annotations WHERE review_id = ?)",
          ).run(id);
          db.prepare("DELETE FROM review_annotations WHERE review_id = ?").run(
            id,
          );
          db.prepare("DELETE FROM review_files WHERE review_id = ?").run(id);
          db.prepare("DELETE FROM review_viewed_files WHERE review_id = ?").run(
            id,
          );
          db.prepare("DELETE FROM review_revisions WHERE id = ?").run(id);
        }
      })();
      return { deletedCount: ids.length };
    },
    decideResolutionSuggestion({ suggestionId, accept }) {
      const suggestion = db
        .prepare(
          "SELECT annotation_id FROM review_resolution_suggestions WHERE id = ? AND status = 'pending'",
        )
        .get(suggestionId) as { annotation_id: string } | undefined;
      if (!suggestion) throw new Error("Resolution suggestion was not found.");
      const resolvedAt = accept ? Date.now() : null;
      db.transaction(() => {
        db.prepare(
          "UPDATE review_resolution_suggestions SET status = ? WHERE id = ?",
        ).run(accept ? "accepted" : "rejected", suggestionId);
        if (accept) {
          db.prepare(
            "UPDATE review_annotations SET resolved_at = ? WHERE id = ?",
          ).run(resolvedAt, suggestion.annotation_id);
          // Resolving a top-level comment resolves its whole thread.
          db.prepare(
            "UPDATE review_annotations SET resolved_at = ? WHERE parent_id = ?",
          ).run(resolvedAt, suggestion.annotation_id);
        }
      })();
      return { resolvedAt };
    },
    async sendBatch({ reviewId, annotationIds }) {
      const review = read(reviewId);
      if (!review) throw new Error("Review revision was not found.");
      const ids = [...new Set(annotationIds)];
      if (!ids.length && !review.summary)
        throw new Error(
          "Nothing to send: select comments, or add a review note first.",
        );
      const selected = review.annotations.filter(
        (annotation) =>
          ids.includes(annotation.id) &&
          annotation.sentAt === null &&
          annotation.resolvedAt === null &&
          annotation.author !== "agent",
      );
      if (selected.length !== ids.length)
        throw new Error(
          "One or more comments were already sent, no longer exist, or were left by the agent and cannot be sent back.",
        );
      // Thread context: each selected reply travels with its top-level comment
      // (even resolved or agent-written) so the agent never sees an orphan.
      const selectedIds = new Set(selected.map((a) => a.id));
      const context = new Map<string, Annotation>();
      for (const annotation of selected) {
        if (!annotation.parentId) continue;
        const root = review.annotations.find(
          (a) => a.id === annotation.parentId,
        );
        if (root && !selectedIds.has(root.id)) context.set(root.id, root);
      }
      // Group primary selections with their threads for the message.
      const threads = new Map<string | null, Annotation[]>();
      for (const annotation of [...selected, ...context.values()]) {
        const key = annotation.parentId ?? annotation.id;
        const list = threads.get(key) ?? [];
        list.push(annotation);
        threads.set(key, list);
      }
      const threadList = [...threads.entries()]
        .map(([rootId, items]) => ({
          root: context.get(rootId!) ?? selected.find((a) => a.id === rootId),
          replies: items.filter((a) => a.parentId !== null),
        }))
        .sort((a, b) => (a.root?.createdAt ?? 0) - (b.root?.createdAt ?? 0));
      const batchId = randomUUID();
      const claimedAt = Date.now();
      const claim = db.prepare(
        `UPDATE review_annotations SET batch_id = ? WHERE id = ? AND review_id = ? AND sent_at IS NULL AND batch_id IS NULL`,
      );
      const claimed = db.transaction(() =>
        selected.every(
          (annotation) =>
            claim.run(batchId, annotation.id, reviewId).changes === 1,
        ),
      )();
      if (!claimed) {
        db.prepare(
          "UPDATE review_annotations SET batch_id = NULL WHERE batch_id = ?",
        ).run(batchId);
        throw new Error("Comments changed while preparing this batch.");
      }
      const diff = buildDiff(review, selected);
      // Wrap the diff in a fenced code block so chat clients render it as a
      // code block instead of misinterpreting @@/+/− markers as markdown. Use
      // a fence longer than any backtick run in the diff so it can't close
      // early.
      const fence = "`".repeat(
        Math.max(3, ...(diff.match(/`+/g)?.map((run) => run.length) ?? [0])) +
          1,
      );
      const text = [
        "Review feedback:",
        review.summary ? `\nReview summary:\n${review.summary}` : "",
        ...threadList.map(({ root, replies }) => {
          if (!root) return "";
          const anchor = root.fileLevel
            ? `${root.filePath} (whole file)`
            : `${root.filePath}:${root.startLine}${root.endLine === root.startLine ? "" : `-${root.endLine}`} (${root.side})`;
          const lines = [
            `\n- ${anchor} [id: ${root.id}]`,
            `  ${root.body}${context.has(root.id) ? " [context]" : ""}`,
          ];
          for (const reply of replies) {
            lines.push(`  \u21b3 reply (${reply.author}):\n    ${reply.body}`);
          }
          return lines.join("\n");
        }),
        diff
          ? `\nDiff of the reviewed changes:\n\n${fence}diff\n${diff}\n${fence}`
          : "",
      ]
        .filter((part) => part !== "")
        .join("\n");
      try {
        await bb.sdk.threads.send({
          threadId: review.threadId,
          mode: "auto",
          input: [{ type: "text", text, mentions: [] }],
        });
      } catch (error) {
        db.prepare(
          "UPDATE review_annotations SET batch_id = NULL WHERE batch_id = ? AND sent_at IS NULL",
        ).run(batchId);
        throw error;
      }
      const sentAt = Date.now();
      db.prepare(
        "UPDATE review_annotations SET sent_at = ? WHERE batch_id = ?",
      ).run(sentAt, batchId);
      return { sentAt, count: selected.length };
    },
  });
  bb.agents.registerTool({
    name: "review_workspace_refresh",
    description:
      "Create a Review Workspace revision snapshot for this thread so a human can review it. By default snapshots the environment's uncommitted changes. Use a target to review committed code instead: a single commit by sha, or all committed changes on the current branch relative to a merge-base branch (PR-style). Call this before review_workspace_comment when preparing or pre-annotating a review session.",
    parameters: z
      .object({
        target: reviewTargetShape.optional(),
      })
      .strict(),
    async execute(input, { threadId }) {
      const review = await refreshReviewImpl({
        threadId,
        target: input.target,
      });
      const unresolved = review.annotations.filter(
        (annotation) => annotation.resolvedAt === null,
      ).length;
      return {
        content: [
          {
            type: "text",
            text: `Revision ${review.id} created (${describeTarget(review.target)}): ${review.files.length} changed file(s), ${unresolved} open comment(s). Annotate with review_workspace_comment; the human sees it in Review changes.`,
          },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "review_workspace_status",
    description:
      "Inspect the latest Review Workspace revision for this thread: changed files, unresolved review comments with exact file/line anchors, and the review/file notes.",
    parameters: z.object({}).strict(),
    async execute(_params, { threadId }) {
      const review = latest(threadId);
      if (!review)
        return {
          content: [{ type: "text", text: "No review revision exists yet." }],
        };
      const unresolved = review.annotations.filter(
        (annotation) => annotation.resolvedAt === null,
      );
      const text = [
        `Revision ${review.id} (snapshot ${review.snapshot.slice(0, 10)}, ${describeTarget(review.target)})`,
        review.summary
          ? `Review note: ${review.summary}`
          : "Review note: (none)",
        "",
        `Changed files (${review.files.length}):`,
        ...review.files.map(
          (file) =>
            `- ${file.path} (${file.status}, +${file.additions}/-${file.deletions})${review.viewedPaths.includes(file.path) ? " [viewed]" : ""}`,
        ),
        "",
        `Unresolved comments (${unresolved.length}) - top-level ids are for review_workspace_resolve and as parentId for replies in review_workspace_comment:`,
        ...(unresolved.length
          ? unresolved.map(
              (annotation) =>
                `- ${annotation.id}${annotation.parentId ? " (reply)" : ""}${annotation.fileLevel ? " (file-level)" : ""}\n  ${annotation.fileLevel ? `${annotation.filePath} (whole file)` : `${annotation.filePath}:${annotation.startLine}${annotation.endLine === annotation.startLine ? "" : `-${annotation.endLine}`} (${annotation.side})`}${annotation.parentId ? "\n  in reply to top-level comment " + annotation.parentId : ""}\n  ${annotation.body}${annotation.sentAt ? "\n  [already sent to a previous batch]" : ""}`,
            )
          : ["(none)"]),
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  });

  bb.agents.registerTool({
    name: "review_workspace_comment",
    description:
      "Add a line-anchored review comment to the latest Review Workspace revision for this thread. Use exact file path and 1-based line numbers from the current diff. To comment on a whole file rather than a line, pass fileLevel: true (lines become 0). To reply inside an existing thread, pass parentId with the top-level comment's id (from the batch message or review_workspace_status) and omit filePath/side/lines.",
    parameters: z
      .object({
        filePath: z.string().min(1).optional(),
        side: z.enum(["old", "new"]).optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        body: z.string().min(1).max(1000),
        parentId: z.string().uuid().optional(),
        fileLevel: z.boolean().optional(),
        reviewId: z.string().uuid().optional(),
      })
      .strict(),
    async execute(input, { threadId }) {
      const review = input.reviewId ? read(input.reviewId) : latest(threadId);
      if (!review)
        throw new Error(
          "No review revision exists yet. Open Review Workspace first.",
        );
      const result = addAnnotationInternal(
        review.id,
        {
          filePath: input.filePath ?? "",
          side: input.side ?? "new",
          startLine: input.startLine ?? 1,
          endLine: input.endLine ?? input.startLine ?? 1,
          body: input.body,
          ...(input.parentId ? { parentId: input.parentId } : {}),
          ...(input.fileLevel ? { fileLevel: true } : {}),
        },
        "agent",
      );
      return {
        content: [
          {
            type: "text",
            text: input.parentId
              ? `Reply ${result.id} added to thread rooted at ${result.parentId} (anchor ${result.filePath}:${result.startLine}-${result.endLine}).`
              : `Comment ${result.id} added at ${result.filePath}:${result.startLine}-${result.endLine}.`,
          },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "review_workspace_resolve",
    description:
      "Resolve or reopen a Review Workspace comment by id (ids come from review_workspace_status). Resolve after applying the feedback.",
    parameters: z
      .object({
        commentId: z.string().uuid(),
        resolved: z.boolean(),
      })
      .strict(),
    async execute(input) {
      const resolvedAt = input.resolved ? Date.now() : null;
      const result = db
        .prepare("UPDATE review_annotations SET resolved_at = ? WHERE id = ?")
        .run(resolvedAt, input.commentId);
      if (result.changes !== 1) throw new Error("Comment was not found.");
      // Resolving (or reopening) a top-level comment resolves the whole thread.
      db.prepare(
        "UPDATE review_annotations SET resolved_at = ? WHERE parent_id = ?",
      ).run(resolvedAt, input.commentId);
      return {
        content: [
          {
            type: "text",
            text: input.resolved ? "Comment resolved." : "Comment reopened.",
          },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "review_workspace_history",
    description:
      "List recent Review Workspace revisions from other threads in this project (same checkout/environment marked), so this thread can discover previous review comments. Use the listed revision ids with review_workspace_import to pull unresolved comments into this thread's latest revision.",
    parameters: z.object({}).strict(),
    async execute(_params, { threadId }) {
      const callerThread = await bb.sdk.threads.get({ threadId });
      const projectThreads = await bb.sdk.threads.list({
        projectId: callerThread.projectId,
      });
      const rows: Array<{
        revision: {
          id: string;
          createdAt: number;
          target: string;
          files: number;
          unresolved: number;
        };
        title: string;
        sameEnvironment: boolean;
      }> = [];
      for (const other of projectThreads) {
        if (other.id === threadId || other.visibility !== "visible") continue;
        const revisions = db
          .prepare(
            "SELECT id, created_at, target FROM review_revisions WHERE thread_id = ? ORDER BY created_at DESC LIMIT 5",
          )
          .all(other.id) as Array<{
          id: string;
          created_at: number;
          target: string;
        }>;
        for (const revision of revisions) {
          const counts = db
            .prepare(
              "SELECT (SELECT COUNT(*) FROM review_files WHERE review_id = ?) AS files, (SELECT COUNT(*) FROM review_annotations WHERE review_id = ? AND resolved_at IS NULL) AS unresolved",
            )
            .get(revision.id, revision.id) as any;
          rows.push({
            revision: {
              id: revision.id,
              createdAt: revision.created_at,
              target: revision.target,
              files: counts.files,
              unresolved: counts.unresolved,
            },
            title: other.title ?? other.titleFallback ?? other.id,
            sameEnvironment:
              Boolean(callerThread.environmentId) &&
              other.environmentId === callerThread.environmentId,
          });
        }
      }
      rows.sort((a, b) => b.revision.createdAt - a.revision.createdAt);
      if (rows.length === 0)
        return {
          content: [
            {
              type: "text",
              text: "No review revisions exist on other threads in this project.",
            },
          ],
        };
      const text = [
        `Review revisions on other threads (${rows.length}) - import with review_workspace_import:`,
        ...rows
          .slice(0, 20)
          .map(
            (row) =>
              `- ${row.revision.id} - thread "${row.title}"${row.sameEnvironment ? " [same environment]" : ""}, ${describeTarget(decodeTarget(row.revision.target))}, ${row.revision.files} file(s), ${row.revision.unresolved} open comment(s), ${new Date(row.revision.createdAt).toISOString()}`,
          ),
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  });

  bb.agents.registerTool({
    name: "review_workspace_import",
    description:
      "Import unresolved review comments from a Review Workspace revision (possibly from another thread; use review_workspace_history to find revision ids) into this thread's latest revision. By default imports all unresolved comments; pass commentIds for a subset. A reply brings its root, and a root brings its replies. Call review_workspace_refresh first if this thread has no revision yet.",
    parameters: z
      .object({
        reviewId: z.string().uuid(),
        commentIds: z.array(z.string().uuid()).max(100).optional(),
      })
      .strict(),
    async execute(input, { threadId }) {
      const target = latest(threadId);
      if (!target)
        throw new Error(
          "No review revision exists yet. Call review_workspace_refresh first so imported comments anchor to a diff.",
        );
      const source = read(input.reviewId);
      if (!source) throw new Error("Source review revision was not found.");
      if (source.id === target.id)
        throw new Error(
          "The source revision is already this thread's latest revision.",
        );
      const callerThread = await bb.sdk.threads.get({ threadId });
      let sourceThread: { projectId: string } | null = null;
      try {
        sourceThread = await bb.sdk.threads.get({ threadId: source.threadId });
      } catch {
        sourceThread = null;
      }
      if (!sourceThread || sourceThread.projectId !== callerThread.projectId)
        throw new Error(
          "Review comments can only be imported from threads in the same project.",
        );
      const ids =
        input.commentIds ??
        source.annotations
          .filter((annotation) => annotation.resolvedAt === null)
          .map((annotation) => annotation.id);
      if (ids.length === 0)
        return {
          content: [
            {
              type: "text",
              text: "Nothing to import: the source revision has no unresolved comments.",
            },
          ],
        };
      const imported = carryCommentsInternal(source.id, target.id, ids).filter(
        (annotation) =>
          annotation.carriedFromAnnotationId !== null &&
          new Set(ids).has(annotation.carriedFromAnnotationId),
      );
      const text = [
        `Imported ${imported.length} comment(s) from revision ${source.id} into ${target.id}:`,
        ...imported.map(
          (annotation) =>
            `- ${annotation.id}${annotation.parentId ? " (reply)" : ""} ${annotation.filePath}:${annotation.startLine}${annotation.endLine === annotation.startLine ? "" : `-${annotation.endLine}`} (${annotation.author}): ${annotation.body}`,
        ),
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  });

  bb.agents.registerTool({
    name: "review_workspace_clear",
    description:
      'Delete Review Workspace revisions for this thread (scope "thread") or for every thread (scope "all"). Destructive: removes revisions, comments, and notes. Used to start a review fresh.',
    parameters: z.object({ scope: z.enum(["thread", "all"]) }).strict(),
    async execute(input, { threadId }) {
      const ids =
        input.scope === "all"
          ? (db.prepare("SELECT id FROM review_revisions").all() as Array<{
              id: string;
            }>)
          : (db
              .prepare("SELECT id FROM review_revisions WHERE thread_id = ?")
              .all(threadId) as Array<{ id: string }>);
      const wipe = db.transaction(() => {
        for (const { id } of ids) {
          db.prepare(
            "DELETE FROM review_resolution_suggestions WHERE annotation_id IN (SELECT id FROM review_annotations WHERE review_id = ?)",
          ).run(id);
          db.prepare("DELETE FROM review_annotations WHERE review_id = ?").run(
            id,
          );
          db.prepare("DELETE FROM review_files WHERE review_id = ?").run(id);
          db.prepare("DELETE FROM review_viewed_files WHERE review_id = ?").run(
            id,
          );
          db.prepare(
            "DELETE FROM review_review_summaries WHERE review_id = ?",
          ).run(id);
          db.prepare("DELETE FROM review_entities WHERE review_id = ?").run(id);
          db.prepare("DELETE FROM review_revisions WHERE id = ?").run(id);
        }
        // Sweep orphaned summaries/entities left by older deletion paths.
        db.prepare(
          "DELETE FROM review_entities WHERE review_id NOT IN (SELECT id FROM review_revisions)",
        ).run();
        db.prepare(
          "DELETE FROM review_review_summaries WHERE review_id NOT IN (SELECT id FROM review_revisions)",
        ).run();
      });
      wipe();
      return {
        content: [
          {
            type: "text",
            text: `Deleted ${ids.length} review revision(s) (scope: ${input.scope}).`,
          },
        ],
      };
    },
  });

  bb.log.info("Review Workspace loaded");
}

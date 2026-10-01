import { describe, expect, it } from "vitest";
import {
  compareSnapshots,
  compareSinceViewed,
  decodeReviewTarget,
  describeReviewTarget,
  encodeReviewTarget,
  isDeferredDiff,
  type DeltaSnapshot,
  type ViewedBaseline,
} from "./review-model";

describe("review model", () => {
  it.each([
    { type: "uncommitted" } as const,
    { type: "commit", sha: "abc123456789" } as const,
    { type: "branch_committed", mergeBaseBranch: "release/1.x" } as const,
    { type: "all", mergeBaseBranch: "main" } as const,
  ])("round-trips target $type", (target) => {
    expect(decodeReviewTarget(encodeReviewTarget(target))).toEqual(target);
  });

  it("describes all as a branch-wide snapshot and defers only narrow known files", () => {
    expect(describeReviewTarget({ type: "all", mergeBaseBranch: "main" })).toBe(
      "everything vs main",
    );
    expect(isDeferredDiff("apps/web/pnpm-lock.yaml", 20)).toBe(
      "Generated dependency lockfile",
    );
    expect(isDeferredDiff("db/migrate/001_create_users.rb", 300_000)).toBe(
      "Large diff (over 256 KiB)",
    );
    expect(isDeferredDiff("db/schema.rb", 10)).toBe("Generated Rails schema");
    expect(isDeferredDiff("db/migrate/001_create_users.rb", 10)).toBeNull();
  });

  it("compares content identity, reverts, and path unions against a verified base", () => {
    const snapshot = (
      id: string,
      files: DeltaSnapshot["files"],
    ): DeltaSnapshot => ({
      id,
      target: { type: "all", mergeBaseBranch: "main" },
      baseIdentity: "base-sha",
      files,
    });
    const baseline = snapshot("r1", [
      {
        path: "src/change.ts",
        previousPath: null,
        status: "modified",
        binary: false,
        truncated: false,
        oldContent: "base",
        newContent: "one",
        oldIdentity: "base-hash",
        newIdentity: "one-hash",
      },
    ]);
    const iterated = snapshot("r3", []);
    expect(compareSnapshots(baseline, iterated)).toMatchObject({
      status: "comparable",
      changedPaths: ["src/change.ts"],
      baselineId: "r1",
    });
    const same = snapshot("r2", [
      { ...baseline.files[0]!, newContent: "one", newIdentity: "one-hash" },
    ]);
    expect(compareSnapshots(baseline, same).unchangedPaths).toEqual([
      "src/change.ts",
    ]);
  });

  it("uses latest explicit per-file baselines, classifies reverts and renames, and preserves unknowns", () => {
    const row = (
      path: string,
      newIdentity: string | null,
      previousPath: string | null = null,
      status = "modified",
    ): ViewedBaseline["file"] => ({
      path,
      previousPath,
      status,
      binary: false,
      truncated: false,
      oldContent: "base",
      newContent: newIdentity,
      oldIdentity: "base-id",
      newIdentity,
    });
    const current: DeltaSnapshot = {
      id: "current",
      target: { type: "all", mergeBaseBranch: "main" },
      baseIdentity: "base-sha",
      files: [
        row("src/a.ts", "a2"),
        row("src/renamed.ts", "renamed", "src/old-name.ts", "renamed"),
        { ...row("src/unknown.png", null), binary: true, oldIdentity: null },
      ],
    };
    const viewed: ViewedBaseline[] = [
      {
        path: "src/a.ts",
        reviewId: "r1",
        viewedAt: 100,
        createdAt: 1,
        baseIdentity: "base-sha",
        file: row("src/a.ts", "a1"),
      },
      {
        path: "src/a.ts",
        reviewId: "r2",
        viewedAt: 100,
        createdAt: 2,
        baseIdentity: "base-sha",
        file: row("src/a.ts", "a2"),
      },
      {
        path: "src/gone.ts",
        reviewId: "r1",
        viewedAt: 90,
        createdAt: 1,
        baseIdentity: "base-sha",
        file: row("src/gone.ts", "gone"),
      },
      {
        path: "src/old-name.ts",
        reviewId: "r1",
        viewedAt: 90,
        createdAt: 1,
        baseIdentity: "base-sha",
        file: row("src/old-name.ts", "renamed-old"),
      },
    ];
    expect(compareSinceViewed(current, viewed)).toMatchObject({
      status: "unknown",
      changedPaths: ["src/gone.ts", "src/old-name.ts", "src/renamed.ts"],
      unchangedPaths: ["src/a.ts"],
      unknownPaths: ["src/unknown.png"],
      revertedPaths: ["src/gone.ts"],
      baselines: expect.arrayContaining([
        { path: "src/a.ts", reviewId: "r2", viewedAt: 100 },
      ]),
    });
  });

  it("does not call missing or incompatible evidence unchanged", () => {
    const first: DeltaSnapshot = {
      id: "r1",
      target: { type: "branch_committed", mergeBaseBranch: "main" },
      baseIdentity: "base-1",
      files: [],
    };
    const next = { ...first, id: "r2", baseIdentity: "base-2" };
    expect(compareSnapshots(first, next).status).toBe("incompatible");
    const unavailable: DeltaSnapshot = {
      ...first,
      id: "r3",
      files: [
        {
          path: "image.png",
          previousPath: null,
          status: "modified",
          binary: true,
          truncated: false,
          oldContent: null,
          newContent: null,
          oldIdentity: null,
          newIdentity: null,
        },
      ],
    };
    expect(compareSnapshots(first, unavailable)).toMatchObject({
      status: "unknown",
      unknownPaths: ["image.png"],
    });
  });
});

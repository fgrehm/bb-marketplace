export type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "commit"; sha: string }
  | { type: "branch_committed"; mergeBaseBranch: string }
  | { type: "all"; mergeBaseBranch: string };

export function encodeReviewTarget(target: ReviewTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "uncommitted";
    case "commit":
      return `commit:${target.sha}`;
    case "branch_committed":
    case "all":
      return `${target.type}:${target.mergeBaseBranch}`;
  }
}

export function decodeReviewTarget(value: string): ReviewTarget {
  const separator = value.indexOf(":");
  if (separator < 0) return { type: "uncommitted" };
  const type = value.slice(0, separator);
  const detail = value.slice(separator + 1);
  if (type === "commit" && detail) return { type: "commit", sha: detail };
  if (type === "branch_committed" && detail)
    return { type: "branch_committed", mergeBaseBranch: detail };
  if (type === "all" && detail) return { type: "all", mergeBaseBranch: detail };
  return { type: "uncommitted" };
}

export function describeReviewTarget(target: ReviewTarget): string {
  switch (target.type) {
    case "commit":
      return `commit ${target.sha.slice(0, 10)}`;
    case "branch_committed":
      return `committed vs ${target.mergeBaseBranch}`;
    case "all":
      return `everything vs ${target.mergeBaseBranch}`;
    case "uncommitted":
      return "uncommitted changes";
  }
}

export function isDeferredDiff(
  path: string,
  patchBytes: number,
): string | null {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized
    .slice(normalized.lastIndexOf("/") + 1)
    .toLowerCase();
  if (["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].includes(basename))
    return "Generated dependency lockfile";
  if (normalized === "db/schema.rb" || normalized === "db/structure.sql")
    return "Generated Rails schema";
  if (patchBytes > 256 * 1024) return "Large diff (over 256 KiB)";
  return null;
}

export type DeltaFile = {
  path: string;
  previousPath: string | null;
  status: string;
  binary: boolean;
  truncated: boolean;
  oldContent: string | null;
  newContent: string | null;
  oldIdentity: string | null;
  newIdentity: string | null;
};

function effectiveIdentity(
  file: DeltaFile,
  side: "old" | "new",
): string | null {
  if (side === "old" && file.status === "added") return "@absent";
  if (side === "new" && file.status === "deleted") return "@absent";
  return side === "old" ? file.oldIdentity : file.newIdentity;
}

export type DeltaSnapshot = {
  id: string;
  target: ReviewTarget;
  baseIdentity: string | null;
  files: DeltaFile[];
};

export type DeltaResult = {
  status: "comparable" | "incompatible" | "unknown";
  baselineId: string;
  changedPaths: string[];
  unchangedPaths: string[];
  unknownPaths: string[];
  reason: string | null;
};

function compatibleBase(a: DeltaSnapshot, b: DeltaSnapshot): boolean {
  return Boolean(
    a.baseIdentity && b.baseIdentity && a.baseIdentity === b.baseIdentity,
  );
}

/** Compare effective file sides. A missing row is reconstructable only when the
 * snapshots share a verified base, in which case the existing row's old side
 * is the common-base content. */
export type ViewedBaseline = {
  path: string;
  reviewId: string;
  viewedAt: number;
  createdAt: number;
  baseIdentity: string | null;
  file: DeltaFile;
};
export type ViewedDeltaResult = {
  status: "comparable" | "unknown";
  changedPaths: string[];
  unchangedPaths: string[];
  unknownPaths: string[];
  revertedPaths: string[];
  baselines: Array<{ path: string; reviewId: string; viewedAt: number }>;
  reason: string | null;
};

/** The per-path baseline is the newest revision where that file was explicitly
 * marked viewed. Merely opening or comparing a revision never advances it. */
export function compareSinceViewed(
  current: DeltaSnapshot,
  viewed: ViewedBaseline[],
): ViewedDeltaResult {
  const latest = new Map<string, ViewedBaseline>();
  for (const item of viewed) {
    const prior = latest.get(item.path);
    if (
      !prior ||
      item.viewedAt > prior.viewedAt ||
      (item.viewedAt === prior.viewedAt && item.createdAt > prior.createdAt)
    )
      latest.set(item.path, item);
  }
  const currentByPath = new Map(current.files.map((file) => [file.path, file]));
  const renamedFrom = new Set(
    current.files
      .map((file) => file.previousPath)
      .filter((path): path is string => Boolean(path)),
  );
  const paths = new Set([...currentByPath.keys(), ...latest.keys()]);
  const changedPaths: string[] = [];
  const unchangedPaths: string[] = [];
  const unknownPaths: string[] = [];
  const revertedPaths: string[] = [];
  const baselines: ViewedDeltaResult["baselines"] = [];
  for (const path of paths) {
    const now = currentByPath.get(path);
    const baseline = latest.get(path);
    if (!baseline) {
      if (now) {
        if (
          now.truncated ||
          (now.binary && !now.oldIdentity && !now.newIdentity)
        )
          unknownPaths.push(path);
        else if (
          now.oldIdentity ||
          now.newIdentity ||
          now.status === "added" ||
          now.status === "deleted"
        )
          changedPaths.push(path);
        else unknownPaths.push(path);
      }
      continue;
    }
    baselines.push({
      path,
      reviewId: baseline.reviewId,
      viewedAt: baseline.viewedAt,
    });
    if (
      !baseline.baseIdentity ||
      baseline.baseIdentity !== current.baseIdentity ||
      baseline.file.truncated
    ) {
      unknownPaths.push(path);
      continue;
    }
    if (now?.truncated) {
      unknownPaths.push(path);
      continue;
    }
    const baselineIdentity = effectiveIdentity(baseline.file, "new");
    const currentIdentity = now
      ? effectiveIdentity(now, "new")
      : effectiveIdentity(baseline.file, "old");
    if (!baselineIdentity || !currentIdentity) {
      unknownPaths.push(path);
      continue;
    }
    if (baselineIdentity === currentIdentity) unchangedPaths.push(path);
    else {
      changedPaths.push(path);
      if (!now && !renamedFrom.has(path)) revertedPaths.push(path);
    }
  }
  const anyUnknown = unknownPaths.length > 0;
  return {
    status: anyUnknown ? "unknown" : "comparable",
    changedPaths: changedPaths.sort(),
    unchangedPaths: unchangedPaths.sort(),
    unknownPaths: unknownPaths.sort(),
    revertedPaths: revertedPaths.sort(),
    baselines: baselines.sort((a, b) => a.path.localeCompare(b.path)),
    reason: anyUnknown
      ? "Some viewed baselines or current file sides are unavailable or use a different comparison base."
      : null,
  };
}

export function compareSnapshots(
  baseline: DeltaSnapshot,
  current: DeltaSnapshot,
): DeltaResult {
  const empty = (
    status: DeltaResult["status"],
    reason: string,
  ): DeltaResult => ({
    status,
    baselineId: baseline.id,
    changedPaths: [],
    unchangedPaths: [],
    unknownPaths: [
      ...new Set(
        [...baseline.files, ...current.files].map((file) => file.path),
      ),
    ].sort(),
    reason,
  });
  if (!compatibleBase(baseline, current))
    return empty(
      "incompatible",
      "Snapshots do not share a verified comparison base.",
    );

  const beforeByPath = new Map(baseline.files.map((file) => [file.path, file]));
  const afterByPath = new Map(current.files.map((file) => [file.path, file]));
  const paths = new Set<string>();
  for (const file of baseline.files) paths.add(file.path);
  for (const file of current.files) {
    paths.add(file.path);
    if (file.previousPath) paths.add(file.previousPath);
  }

  const changedPaths: string[] = [];
  const unchangedPaths: string[] = [];
  const unknownPaths: string[] = [];
  for (const path of paths) {
    const before = beforeByPath.get(path);
    const after = afterByPath.get(path);
    const beforeIdentity = before?.newIdentity ?? before?.oldIdentity ?? null;
    const afterIdentity = after?.newIdentity ?? after?.oldIdentity ?? null;
    const beforeContent = before?.newContent ?? before?.oldContent ?? null;
    const afterContent = after?.newContent ?? after?.oldContent ?? null;
    if (
      before?.truncated ||
      after?.truncated ||
      (before?.binary && beforeIdentity === null) ||
      (after?.binary && afterIdentity === null) ||
      (!before && !after)
    ) {
      unknownPaths.push(path);
      continue;
    }
    // For a path that stopped appearing in the diff, its prior old side is
    // exactly the current effective content only when both captures share base.
    if (!after && before && before.oldIdentity !== null) {
      if (beforeIdentity === before.oldIdentity) unchangedPaths.push(path);
      else changedPaths.push(path);
      continue;
    }
    if (!before && after && after.oldIdentity !== null) {
      if (after.newIdentity === after.oldIdentity) unchangedPaths.push(path);
      else changedPaths.push(path);
      continue;
    }
    if (beforeIdentity === null || afterIdentity === null) {
      if (beforeContent !== null && afterContent !== null) {
        (beforeContent === afterContent ? unchangedPaths : changedPaths).push(
          path,
        );
      } else {
        unknownPaths.push(path);
      }
      continue;
    }
    (beforeIdentity === afterIdentity ? unchangedPaths : changedPaths).push(
      path,
    );
  }
  const anyUnknown = unknownPaths.length > 0;
  return {
    status: anyUnknown ? "unknown" : "comparable",
    baselineId: baseline.id,
    changedPaths: changedPaths.sort(),
    unchangedPaths: unchangedPaths.sort(),
    unknownPaths: unknownPaths.sort(),
    reason: anyUnknown
      ? "Some snapshot sides are unavailable or truncated."
      : null,
  };
}

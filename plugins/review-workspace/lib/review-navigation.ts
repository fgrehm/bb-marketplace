export type ChangedFilePath = { path: string };
export type FileFilterMode = "all" | "unviewed" | "with-open-comments";
export type FileFilterContext = {
  mode: FileFilterMode;
  viewedPaths: ReadonlySet<string>;
  openThreadCounts: ReadonlyMap<string, number>;
};

export function unresolvedRootThreadCounts<
  T extends {
    filePath: string;
    parentId: string | null;
    resolvedAt: number | null;
  },
>(annotations: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const annotation of annotations) {
    if (annotation.parentId !== null || annotation.resolvedAt !== null)
      continue;
    counts.set(annotation.filePath, (counts.get(annotation.filePath) ?? 0) + 1);
  }
  return counts;
}

export function filterChangedFiles<T extends ChangedFilePath>(
  files: T[],
  query: string,
  context: FileFilterContext = {
    mode: "all",
    viewedPaths: new Set(),
    openThreadCounts: new Map(),
  },
): T[] {
  const normalized = query.trim().toLowerCase();
  return files.filter((file) => {
    if (normalized && !file.path.toLowerCase().includes(normalized))
      return false;
    if (context.mode === "unviewed" && context.viewedPaths.has(file.path))
      return false;
    if (
      context.mode === "with-open-comments" &&
      !context.openThreadCounts.has(file.path)
    )
      return false;
    return true;
  });
}

export function adjacentFilePath<T extends ChangedFilePath>(
  files: T[],
  currentPath: string | null,
  direction: -1 | 1,
): string | null {
  if (!files.length) return null;
  const index = Math.max(
    0,
    files.findIndex((file) => file.path === currentPath),
  );
  return files[(index + direction + files.length) % files.length]?.path ?? null;
}

/**
 * Find the next unviewed file after the current one, wrapping once through the
 * review order. The current file is excluded because callers mark it viewed
 * before navigating. A null result means the review has no remaining files.
 */
export function nextUnviewedFilePath<T extends ChangedFilePath>(
  files: T[],
  currentPath: string,
  viewedPaths: string[],
): string | null {
  const currentIndex = files.findIndex((file) => file.path === currentPath);
  if (currentIndex < 0) return null;
  const viewed = new Set(viewedPaths);
  for (let offset = 1; offset < files.length; offset += 1) {
    const candidate = files[(currentIndex + offset) % files.length];
    if (candidate && !viewed.has(candidate.path)) return candidate.path;
  }
  return null;
}

export type ChangedFilePath = { path: string };

export function filterChangedFiles<T extends ChangedFilePath>(
  files: T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  return normalized
    ? files.filter((file) => file.path.toLowerCase().includes(normalized))
    : files;
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

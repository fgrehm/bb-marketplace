import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type ChangeKind = "added" | "deleted" | "renamed" | "modified";

/**
 * Normalize a change-kind/status value (BB's changeKind word form or a git
 * status letter, in any case) to one of the four canonical kinds.
 */
export function normalizeChangeKind(status: string): ChangeKind {
  const kind = status.toLowerCase();
  if (kind.startsWith("a")) return "added";
  if (kind.startsWith("d")) return "deleted";
  if (kind.startsWith("r")) return "renamed";
  return "modified";
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Compact a path for a narrow display column. Abbreviates the earliest
 * directory segments to their first character ("components/really/deep/x/y.ts"
 * becomes "c/r/d/x/y.ts"), which preserves the full file name and the most
 * specific directories instead of clipping blind middle characters. Falls back
 * to middle-truncating when the file name alone exceeds the budget. Returns
 * the input unchanged when it already fits.
 */
export function compactPath(pathValue: string, maxLength: number): string {
  if (pathValue.length <= maxLength || maxLength < 4) return pathValue;
  const segments = pathValue.split("/");
  const last = segments.length - 1;
  let abbreviated = 0;
  while (segments.join("/").length > maxLength && abbreviated < last) {
    segments[abbreviated] = segments[abbreviated]![0]!;
    abbreviated += 1;
  }
  const compacted = segments.join("/");
  if (compacted.length <= maxLength) return compacted;
  const headLength = Math.max(1, Math.floor((maxLength - 1) * 0.5));
  const tailLength = maxLength - 1 - headLength;
  return `${compacted.slice(0, headLength)}…${compacted.slice(-tailLength)}`;
}

export function formatHomePathForDisplay(pathValue: string): string {
  const homePrefix =
    pathValue.match(/^\/Users\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/home\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/root(?=\/|$)/)?.[0] ??
    pathValue.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i)?.[0];
  return homePrefix === undefined
    ? pathValue
    : `~${pathValue.slice(homePrefix.length)}`;
}

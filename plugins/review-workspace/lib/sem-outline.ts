// EXPERIMENTAL helpers for the entity-level diff outline (lib/sem.ts powers
// the data side). Mapping only, no spawning here.
import type { SemEntityChange } from "./sem";

export type { SemEntityChange };

// sem reports entity ranges in whole-file (new-side) coordinates; the unified
// diff only shows hunk lines. Anchor an entity to the first added/context
// line inside its range so outline rows can scroll somewhere meaningful.
// Returns null when the entity overlaps no visible lines, in which case the
// outline row renders without a locator.
export function entityAnchor(
  entity: SemEntityChange,
  patch: string,
): { side: "new" | "old"; line: number } | null {
  if (entity.startLine == null) return null;
  const lo = entity.startLine;
  const hi = entity.endLine ?? entity.startLine;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      // @@ -oldStart,oldLines +newStart,newLines @@
      const match = /-(\d+)/.exec(raw);
      const plus = /\+(\d+)/.exec(raw);
      oldLine = match ? Number(match[1]) - 1 : oldLine;
      newLine = plus ? Number(plus[1]) - 1 : newLine;
      continue;
    }
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === "-") {
      oldLine++;
      continue;
    }
    if (marker === "+") {
      newLine++;
      if (body && newLine >= lo && newLine <= hi)
        return { side: "new", line: newLine };
      continue;
    }
    if (marker === "\\") continue;
    newLine++;
    oldLine++;
    if (body && newLine >= lo && newLine <= hi)
      return { side: "new", line: newLine };
  }
  return null;
}

export const changeTypeLabels: Record<SemEntityChange["changeType"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  moved: "moved",
  renamed: "renamed",
  reordered: "reordered",
};

// Compact LCS line diff for per-entity before/after content in the entities
// view. Returns changed lines only; empty when sem omitted the content
// (oversized blob or deleted/added without the other side).
export type EntityDiffLine =
  | { marker: "-"; text: string }
  | { marker: "+"; text: string }
  | { marker: " "; text: string };

function lcsLines(a: string[], b: string[]): EntityDiffLine[] {
  // LCS table (entities are small; capped server-side).
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: EntityDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ marker: " ", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ marker: "-", text: a[i] });
      i++;
    } else {
      lines.push({ marker: "+", text: b[j] });
      j++;
    }
  }
  while (i < a.length) lines.push({ marker: "-", text: a[i++] });
  while (j < b.length) lines.push({ marker: "+", text: b[j++] });
  return lines;
}

export function entityContentDiff(
  before: string | null | undefined,
  after: string | null | undefined,
): EntityDiffLine[] {
  if (before == null || after == null) return [];
  return lcsLines(before.split("\n"), after.split("\n"));
}

// Synthesize a unified diff for a single entity so its expanded view renders
// through the same Pierre FileDiff surface as the file diff. Context runs
// longer than `contextLines` split into separate hunks, git-style, so a
// one-line change does not drag the whole function along. `maxLines` caps
// total emitted lines; `truncated` reports the cut.
export function entityContentPatch(
  before: string | null | undefined,
  after: string | null | undefined,
  filePath: string,
  opts: {
    oldStart?: number | null;
    newStart?: number | null;
    contextLines?: number;
    maxLines?: number;
  } = {},
): { patch: string; truncated: boolean } | null {
  if (before == null && after == null) return null;
  const contextLines = opts.contextLines ?? 3;
  const maxLines = opts.maxLines ?? 80;
  const lines =
    before == null
      ? (after ?? "")
          .split("\n")
          .map((text) => ({ marker: "+" as const, text }))
      : after == null
        ? before.split("\n").map((text) => ({ marker: "-" as const, text }))
        : lcsLines(before.split("\n"), after.split("\n"));
  if (!lines.length) return null;

  const header =
    `diff --git a/${filePath} b/${filePath}\n` +
    `--- a/${filePath}\n` +
    `+++ b/${filePath}`;

  // Indices of changed lines; group them into hunks with context.
  const changed = lines.map((line) => line.marker !== " ");
  const hunks: Array<[number, number]> = [];
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!changed[i]) continue;
    if (start === -1) {
      start = i;
      end = i;
    } else if (i - end <= contextLines * 2) {
      end = i;
    } else {
      hunks.push([start, end]);
      start = i;
      end = i;
    }
  }
  if (start !== -1) hunks.push([start, end]);

  // Whole-diff fallback: no changed lines means the entity moved wholesale
  // (pure reorder); render the first maxLines lines as one hunk.
  const hunkRanges = hunks.length
    ? hunks.map(([s, e]) => [
        Math.max(0, s - contextLines),
        Math.min(lines.length, e + contextLines + 1),
      ])
    : [[0, Math.min(lines.length, maxLines)]];
  const fallbackTruncated = !hunks.length && lines.length > maxLines;

  // Line numbers of the first kept line per side, computed up front.
  const numbering: Array<[number, number]> = [];
  {
    let o = opts.oldStart ?? 1;
    let n = opts.newStart ?? 1;
    for (const line of lines) {
      numbering.push([o, n]);
      if (line.marker !== "+") o++;
      if (line.marker !== "-") n++;
    }
  }

  let truncated = false;
  let emitted = 0;
  const parts: string[] = [header];
  for (const [from, to] of hunkRanges) {
    if (emitted >= maxLines) {
      truncated = true;
      break;
    }
    const kept = lines.slice(from, to);
    const capped = kept.slice(0, Math.max(0, maxLines - emitted));
    if (capped.length < kept.length) truncated = true;
    if (!capped.length) break;
    const [oStart] = numbering[from];
    const [, nStart] = numbering[from];
    const oCount = capped.filter((line) => line.marker !== "+").length;
    const nCount = capped.filter((line) => line.marker !== "-").length;
    parts.push(
      `@@ -${oCount ? oStart : oStart - 1},${oCount} +${nCount ? nStart : nStart - 1},${nCount} @@`,
    );
    for (const line of capped) {
      parts.push(`${line.marker} ${line.text}`);
    }
    emitted += capped.length;
  }
  return { patch: parts.join("\n"), truncated: truncated || fallbackTruncated };
}

// sem diff emits per-line entity ids for granular entities (properties,
// orphan chunks) with a `@L<n>` line suffix, while `sem impact --entity-id`
// indexes stable ids without the suffix.
export function stableEntityId(entityId: string): string {
  return entityId.replace(/@L\d+(?:-\d+)?$/, "");
}

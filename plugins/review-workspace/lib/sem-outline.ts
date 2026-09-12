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

// Compact LCS line diff for the per-entity content preview in the outline.
// Returns only changed lines plus a bit of context; null when there is no
// inline content (oversized blob or sem omitted it).
export type EntityDiffLine =
  | { marker: "-"; text: string }
  | { marker: "+"; text: string }
  | { marker: " "; text: string };

export function entityContentDiff(
  before: string | null | undefined,
  after: string | null | undefined,
): EntityDiffLine[] {
  if (before == null || after == null) return [];
  const a = before.split("\n");
  const b = after.split("\n");
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

// sem diff emits per-line entity ids for granular entities (properties,
// orphan chunks) with a `@L<n>` line suffix, while `sem impact --entity-id`
// indexes stable ids without the suffix.
export function stableEntityId(entityId: string): string {
  return entityId.replace(/@L\d+(?:-\d+)?$/, "");
}

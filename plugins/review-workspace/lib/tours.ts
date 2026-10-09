export type TourAnchor = {
  filePath: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
};
export type TourStep = {
  id: string;
  title: string;
  body: string;
  anchors: TourAnchor[];
  card?: Record<string, unknown>;
};
export type TourFile = {
  path: string;
  binary: boolean;
  truncated: boolean;
  patch: string;
};
export type AnchorValidation = TourAnchor & {
  valid: boolean;
  reason: string | null;
};
export type TourCoverage = {
  totalChangedLines: number;
  coveredChangedLines: number;
  uncovered: Array<{ filePath: string; side: "old" | "new"; line: number }>;
};

function patchLineSets(patch: string) {
  const lines = { old: new Set<number>(), new: new Set<number>() };
  const changes: Array<{ side: "old" | "new"; line: number }> = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const marker = line[0];
    if (marker === " ") {
      lines.old.add(oldLine++);
      lines.new.add(newLine++);
    } else if (marker === "-") {
      lines.old.add(oldLine);
      changes.push({ side: "old", line: oldLine++ });
    } else if (marker === "+") {
      lines.new.add(newLine);
      changes.push({ side: "new", line: newLine++ });
    }
  }
  return { lines, changes };
}

export function patchHunkStarts(patch: string, side: "old" | "new"): number[] {
  const pattern = side === "old" ? /^@@ -(\d+)/ : /^@@ -\d+(?:,\d+)? \+(\d+)/;
  return patch
    .split("\n")
    .flatMap((line) => {
      const match = pattern.exec(line);
      return match ? [Number(match[1])] : [];
    })
    .filter((line) => line > 0);
}

export function patchSourceLines(patch: string, side: "old" | "new"): number[] {
  return [...patchLineSets(patch).lines[side]].sort((a, b) => a - b);
}

export function isVisiblePatchRange(
  patch: string,
  side: "old" | "new",
  startLine: number,
  endLine: number,
): boolean {
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine - startLine > 5000
  )
    return false;
  const lines = patchLineSets(patch).lines[side];
  for (let line = startLine; line <= endLine; line++)
    if (!lines.has(line)) return false;
  return true;
}

/** Build a bounded, syntactically valid patch excerpt from immutable hunks. */
export function excerptPatch(
  patch: string,
  anchor: TourAnchor,
  context = 3,
): string | null {
  if (
    !isVisiblePatchRange(patch, anchor.side, anchor.startLine, anchor.endLine)
  )
    return null;
  const source = patch.split("\n");
  const firstHunk = source.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk < 0) return null;
  const output = source.slice(0, firstHunk);
  let included = false;
  for (let i = firstHunk; i < source.length;) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(
      source[i] ?? "",
    );
    if (!header) {
      i++;
      continue;
    }
    let old = Number(header[1]),
      next = Number(header[2]);
    const rows: Array<{
      text: string;
      old: number;
      next: number;
      oldCount: number;
      newCount: number;
      match: boolean;
    }> = [];
    for (i++; i < source.length && !source[i]?.startsWith("@@ "); i++) {
      const text = source[i]!;
      if (text.startsWith("\\ No newline") && rows.length) {
        rows[rows.length - 1]!.text += "\n" + text;
        continue;
      }
      if (![" ", "+", "-"].includes(text[0] ?? "")) continue;
      const oldCount = text[0] === "+" ? 0 : 1;
      const newCount = text[0] === "-" ? 0 : 1;
      const number = anchor.side === "old" ? old : next;
      const exists = anchor.side === "old" ? oldCount : newCount;
      rows.push({
        text,
        old,
        next,
        oldCount,
        newCount,
        match: Boolean(
          exists && number >= anchor.startLine && number <= anchor.endLine,
        ),
      });
      old += oldCount;
      next += newCount;
    }
    const start = rows.findIndex((row) => row.match);
    if (start < 0) continue;
    const end = rows
      .map((row, index) => (row.match ? index : -1))
      .filter((index) => index >= 0)
      .at(-1)!;
    const selected = rows.slice(
      Math.max(0, start - context),
      end + context + 1,
    );
    const first = selected[0]!;
    const oldCount = selected.reduce((count, row) => count + row.oldCount, 0);
    const newCount = selected.reduce((count, row) => count + row.newCount, 0);
    output.push(
      `@@ -${oldCount ? first.old : Math.max(0, first.old - 1)},${oldCount} +${newCount ? first.next : Math.max(0, first.next - 1)},${newCount} @@`,
      ...selected.map((row) => row.text),
    );
    included = true;
  }
  return included ? output.join("\n") + "\n" : null;
}

export function validateTour(
  files: TourFile[],
  steps: TourStep[],
): { anchors: AnchorValidation[][]; coverage: TourCoverage } {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const lineSets = new Map(
    files.map((file) => [file.path, patchLineSets(file.patch)]),
  );
  const anchors = steps.map((step) =>
    step.anchors.map((anchor): AnchorValidation => {
      const file = byPath.get(anchor.filePath);
      let reason: string | null = null;
      if (!file) reason = "file-not-in-revision";
      else if (file.binary) reason = "binary-file";
      else if (file.truncated) reason = "truncated-file";
      else if (
        !Number.isInteger(anchor.startLine) ||
        !Number.isInteger(anchor.endLine) ||
        anchor.startLine < 1 ||
        anchor.endLine < anchor.startLine ||
        anchor.endLine - anchor.startLine > 5000
      )
        reason = "invalid-range";
      else {
        const available = lineSets.get(anchor.filePath)?.lines[anchor.side];
        if (
          !available ||
          !Array.from(
            { length: anchor.endLine - anchor.startLine + 1 },
            (_, index) => anchor.startLine + index,
          ).every((line) => available.has(line))
        )
          reason = "range-not-visible";
      }
      return { ...anchor, valid: reason === null, reason };
    }),
  );

  const covered = new Set<string>();
  for (const stepAnchors of anchors) {
    for (const anchor of stepAnchors) {
      if (!anchor.valid) continue;
      for (let line = anchor.startLine; line <= anchor.endLine; line++)
        covered.add(`${anchor.filePath}\0${anchor.side}\0${line}`);
    }
  }
  const uncovered: TourCoverage["uncovered"] = [];
  let totalChangedLines = 0;
  for (const file of files) {
    if (file.binary) continue;
    for (const change of lineSets.get(file.path)?.changes ?? []) {
      totalChangedLines++;
      if (!covered.has(`${file.path}\0${change.side}\0${change.line}`))
        uncovered.push({ filePath: file.path, ...change });
    }
  }
  return {
    anchors,
    coverage: {
      totalChangedLines,
      coveredChangedLines: totalChangedLines - uncovered.length,
      uncovered,
    },
  };
}

import { describe, expect, it } from "vitest";
import { getSingularPatch } from "@pierre/diffs";
import { excerptPatch, patchSourceLines } from "./tours";

const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,5 +10,6 @@
 context-a
-old
+replacement
+extra
 context-b
 context-c
 context-d
@@ -40,2 +41,2 @@
 unrelated
-tail
+new-tail
`;

describe("immutable tour excerpts", () => {
  it("preserves exact source numbers and excludes unrelated hunks", () => {
    const excerpt = excerptPatch(
      patch,
      { filePath: "src/a.ts", side: "new", startLine: 11, endLine: 12 },
      1,
    )!;
    expect(excerpt).toContain("@@ -11,2 +11,3 @@");
    expect(excerpt).not.toContain("unrelated");
    expect(excerpt).not.toContain("context-d");
    expect(patchSourceLines(excerpt, "new")).toEqual([11, 12, 13]);
    expect(patchSourceLines(excerpt, "old")).toEqual([11, 12]);
    expect(getSingularPatch(excerpt)).toBeTruthy();
  });

  it("supports deleted-side anchors and zero-length opposite sides", () => {
    const excerpt = excerptPatch(
      patch,
      { filePath: "src/a.ts", side: "old", startLine: 11, endLine: 11 },
      0,
    )!;
    expect(excerpt).toContain("@@ -11,1 +10,0 @@");
    expect(patchSourceLines(excerpt, "old")).toEqual([11]);
    expect(patchSourceLines(excerpt, "new")).toEqual([]);
    expect(getSingularPatch(excerpt)).toBeTruthy();
  });

  it("keeps no-newline metadata without counting it as a source line", () => {
    const single =
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
    const excerpt = excerptPatch(single, {
      filePath: "a",
      side: "new",
      startLine: 1,
      endLine: 1,
    })!;
    expect(excerpt.match(/No newline/g)).toHaveLength(2);
    expect(patchSourceLines(excerpt, "new")).toEqual([1]);
  });

  it("rejects invisible, reversed, and cross-gap ranges instead of inventing code", () => {
    for (const [startLine, endLine] of [
      [1, 1],
      [12, 11],
      [11, 42],
    ]) {
      expect(
        excerptPatch(patch, {
          filePath: "src/a.ts",
          side: "new",
          startLine,
          endLine,
        }),
      ).toBeNull();
    }
  });

  it("bounds context around a single anchor in a very large added hunk", () => {
    const large = `diff --git a/a b/a\n--- /dev/null\n+++ b/a\n@@ -0,0 +1,1000 @@\n${Array.from({ length: 1000 }, (_, i) => "+line " + (i + 1)).join("\n")}\n`;
    const excerpt = excerptPatch(large, {
      filePath: "a",
      side: "new",
      startLine: 500,
      endLine: 500,
    })!;
    expect(patchSourceLines(excerpt, "new")).toEqual([
      497, 498, 499, 500, 501, 502, 503,
    ]);
    expect(getSingularPatch(excerpt)).toBeTruthy();
  });
});

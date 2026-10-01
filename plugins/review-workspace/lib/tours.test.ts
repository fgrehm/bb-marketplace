import { describe, expect, it } from "vitest";
import {
  isVisiblePatchRange,
  patchHunkStarts,
  patchSourceLines,
  validateTour,
  type TourStep,
} from "./tours";

const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 context
-old
+new
 context
`;
const files = [
  { path: "src/a.ts", patch, binary: false, truncated: false },
  { path: "asset.bin", patch: "", binary: true, truncated: false },
  { path: "large.ts", patch, binary: false, truncated: true },
];

describe("tour anchor validation and raw coverage", () => {
  it("exposes exact old/new source lines and validates full ranges", () => {
    expect(patchSourceLines(patch, "old")).toEqual([1, 2, 3]);
    expect(patchSourceLines(patch, "new")).toEqual([1, 2, 3]);
    expect(patchHunkStarts(patch, "old")).toEqual([1]);
    expect(patchHunkStarts(patch, "new")).toEqual([1]);
    expect(isVisiblePatchRange(patch, "old", 2, 3)).toBe(true);
    expect(isVisiblePatchRange(patch, "new", 2, 4)).toBe(false);
  });
  it("validates exact old/new ranges, context, and deleted lines", () => {
    const steps: TourStep[] = [
      {
        id: "step",
        title: "Change",
        body: "Read the replacement.",
        anchors: [
          { filePath: "src/a.ts", side: "old", startLine: 2, endLine: 2 },
          { filePath: "src/a.ts", side: "new", startLine: 2, endLine: 3 },
          { filePath: "src/a.ts", side: "new", startLine: 10, endLine: 10 },
          { filePath: "missing.ts", side: "new", startLine: 1, endLine: 1 },
        ],
      },
    ];
    const result = validateTour(files, steps);
    expect(
      result.anchors[0]?.map(({ valid, reason }) => ({ valid, reason })),
    ).toEqual([
      { valid: true, reason: null },
      { valid: true, reason: null },
      { valid: false, reason: "range-not-visible" },
      { valid: false, reason: "file-not-in-revision" },
    ]);
  });

  it("reports invalid asset/truncation anchors and residual raw changes", () => {
    const result = validateTour(files, [
      {
        id: "step",
        title: "Only half",
        body: "",
        anchors: [
          { filePath: "src/a.ts", side: "new", startLine: 2, endLine: 2 },
          { filePath: "asset.bin", side: "new", startLine: 1, endLine: 1 },
          { filePath: "large.ts", side: "new", startLine: 2, endLine: 2 },
        ],
      },
    ]);
    expect(result.anchors[0]?.map((anchor) => anchor.reason)).toEqual([
      null,
      "binary-file",
      "truncated-file",
    ]);
    expect(result.coverage).toMatchObject({
      totalChangedLines: 4,
      coveredChangedLines: 1,
      uncovered: expect.arrayContaining([
        { filePath: "src/a.ts", side: "old", line: 2 },
        { filePath: "large.ts", side: "new", line: 2 },
      ]),
    });
  });
});

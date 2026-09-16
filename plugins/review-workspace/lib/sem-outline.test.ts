import { describe, expect, it } from "vitest";
import {
  entityAnchor,
  entityContentDiff,
  entityContentPatch,
} from "./sem-outline";

const patch = `@@ -10,7 +10,8 @@ context
 function one() {
   return 1;
 }
+
+function addedThing() {
+  return 2;
 }
 function two() {
   return 3;
 }`;

describe("entityAnchor", () => {
  it("anchors to the first changed line Inside the entity range", () => {
    const anchor = entityAnchor(
      {
        entityId: "src/a.ts::function::addedThing",
        changeType: "added",
        entityType: "function",
        entityName: "addedThing",
        oldStartLine: null,
        oldEndLine: null,
        filePath: "src/a.ts",
        startLine: 13,
        endLine: 16,
        structuralChange: null,
      },
      patch,
    );
    // hunk starts at +10; the first added body line within the range is 14.
    expect(anchor).toEqual({ side: "new", line: 14 });
  });

  it("keeps hunk counters in sync across context lines", () => {
    const patchWithContext = `@@ -2,4 +2,5 @@ c
 one
+added early
 two
 three
`;
    expect(
      entityAnchor(
        {
          entityId: "e",
          changeType: "modified",
          entityType: "code",
          entityName: "e",
          oldStartLine: null,
          oldEndLine: null,
          filePath: "src/a.ts",
          startLine: 3,
          endLine: 3,
          structuralChange: null,
        },
        patchWithContext,
      ),
    ).toEqual({ side: "new", line: 3 });
  });

  it("returns null for lines outside the visible hunks", () => {
    expect(
      entityAnchor(
        {
          entityId: "e",
          changeType: "modified",
          entityType: "code",
          entityName: "e",
          oldStartLine: null,
          oldEndLine: null,
          filePath: "src/a.ts",
          startLine: 900,
          endLine: 910,
          structuralChange: null,
        },
        patch,
      ),
    ).toBeNull();
  });

  it("returns null when the range is unknown", () => {
    expect(
      entityAnchor(
        {
          entityId: "e",
          changeType: "deleted",
          entityType: "code",
          entityName: "e",
          oldStartLine: null,
          oldEndLine: null,
          filePath: "src/a.ts",
          startLine: null,
          endLine: null,
          structuralChange: null,
        },
        patch,
      ),
    ).toBeNull();
  });
});

describe("entityContentDiff", () => {
  it("renders a compact LCS line diff for two-sided content", () => {
    const lines = entityContentDiff(
      "function a() {\n  return 1;\n}",
      "function a() {\n  return 2;\n}",
    );
    expect(lines).toEqual([
      { marker: " ", text: "function a() {" },
      { marker: "-", text: "  return 1;" },
      { marker: "+", text: "  return 2;" },
      { marker: " ", text: "}" },
    ]);
  });

  it("returns an empty diff for one-sided or missing content", () => {
    expect(entityContentDiff(null, "after")).toEqual([]);
    expect(entityContentDiff("before", null)).toEqual([]);
    expect(entityContentDiff(undefined, undefined)).toEqual([]);
  });
});

describe("entityContentPatch", () => {
  const fn = [
    "function alpha() {",
    "  const a = 1;",
    "  const b = 2;",
    "  const c = 3;",
    "  const d = 4;",
    "  const e = 5;",
    "  const f = 6;",
    "  const g = 7;",
    "  const h = 8;",
    "  return a + b + c + d;",
    "}",
  ].join("\n");

  it("trims context around a one-line change to a small hunk", () => {
    const after = fn.replace("  const e = 5;", "  const e = 50;");
    const built = entityContentPatch(fn, after, "src/a.ts", {
      oldStart: 10,
      newStart: 10,
    });
    expect(built).not.toBeNull();
    expect(built!.truncated).toBe(false);
    // 3 header lines + 1 hunk header + 3 context + change + 3 context
    expect(built!.patch.split("\n")).toHaveLength(3 + 1 + 8);
    expect(built!.patch).toContain("@@ -12,7 +12,7 @@");

    expect(built!.patch).toContain("-   const e = 5;");
    expect(built!.patch).toContain("+   const e = 50;");
    // far-apart lines are not dragged along
    expect(built!.patch).not.toContain("function alpha()");
    expect(built!.patch).not.toContain("const a = 1;");
  });

  it("renders one-sided content as a full add or full delete", () => {
    const added = entityContentPatch(null, "a\nb", "src/a.ts", {
      newStart: 7,
    });
    expect(added!.patch).toContain("@@ -0,0 +7,2 @@");
    expect(added!.patch).toContain("+ a");
    const deleted = entityContentPatch("a\nb", null, "src/a.ts", {
      oldStart: 7,
    });
    expect(deleted!.patch).toContain("@@ -7,2 +0,0 @@");
    expect(deleted!.patch).toContain("- a");
  });

  it("returns null without content and reports truncation past maxLines", () => {
    expect(entityContentPatch(null, null, "src/a.ts")).toBeNull();
    const built = entityContentPatch(
      "a\nb\nc\nd\ne",
      "a\nb\nc\nd\ne",
      "src/a.ts",
      {
        maxLines: 2,
      },
    );
    // identical content renders as one hunk capped to maxLines
    expect(built!.truncated).toBe(true);
    expect(built!.patch.split("\n")).toHaveLength(3 + 1 + 2);
  });
});

describe("entityContentPatch", () => {
  const fn = [
    "function alpha() {",
    "  const a = 1;",
    "  const b = 2;",
    "  const c = 3;",
    "  const d = 4;",
    "  return a + b + c + d;",
    "}",
  ].join("\n");

  it("trims context around a one-line change to a small hunk", () => {
    const after = fn.replace("  const c = 3;", "  const c = 30;");
    const built = entityContentPatch(fn, after, "src/a.ts", {
      oldStart: 10,
      newStart: 10,
      ecoute: undefined,
    } as never);
  });
});

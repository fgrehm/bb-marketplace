import { describe, expect, it } from "vitest";
import { entityAnchor } from "./sem-outline";

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

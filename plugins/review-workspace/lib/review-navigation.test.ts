import { describe, expect, it } from "vitest";
import {
  adjacentFilePath,
  filterChangedFiles,
  nextUnviewedFilePath,
  unresolvedRootThreadCounts,
} from "./review-navigation";

describe("review file navigation", () => {
  const files = [
    { path: "src/App.tsx" },
    { path: "server.ts" },
    { path: "README.md" },
  ];

  it("filters changed files case-insensitively", () => {
    expect(filterChangedFiles(files, " app ")).toEqual([
      { path: "src/App.tsx" },
    ]);
    expect(filterChangedFiles(files, "missing")).toEqual([]);
  });

  it("combines review-state filters with the text query", () => {
    const context = {
      viewedPaths: new Set(["src/App.tsx"]),
      openThreadCounts: new Map([
        ["src/App.tsx", 1],
        ["README.md", 2],
      ]),
    };
    expect(
      filterChangedFiles(files, "src", { ...context, mode: "unviewed" }),
    ).toEqual([]);
    expect(
      filterChangedFiles(files, "", { ...context, mode: "unviewed" }),
    ).toEqual([{ path: "server.ts" }, { path: "README.md" }]);
    expect(
      filterChangedFiles(files, "read", {
        ...context,
        mode: "with-open-comments",
      }),
    ).toEqual([{ path: "README.md" }]);
    expect(filterChangedFiles(files, "", { ...context, mode: "all" })).toEqual(
      files,
    );
  });

  it("counts unresolved root threads once, including file-level roots", () => {
    const counts = unresolvedRootThreadCounts([
      { filePath: "src/App.tsx", parentId: null, resolvedAt: null },
      { filePath: "src/App.tsx", parentId: "root-1", resolvedAt: null },
      { filePath: "src/App.tsx", parentId: null, resolvedAt: 12 },
      { filePath: "README.md", parentId: null, resolvedAt: null },
    ]);
    expect(counts).toEqual(
      new Map([
        ["src/App.tsx", 1],
        ["README.md", 1],
      ]),
    );
  });

  it("wraps previous and next navigation", () => {
    expect(adjacentFilePath(files, "src/App.tsx", -1)).toBe("README.md");
    expect(adjacentFilePath(files, "README.md", 1)).toBe("src/App.tsx");
    expect(adjacentFilePath(files, null, 1)).toBe("server.ts");
  });

  it("finds the next unviewed file in review order", () => {
    expect(nextUnviewedFilePath(files, "src/App.tsx", ["server.ts"])).toBe(
      "README.md",
    );
    expect(nextUnviewedFilePath(files, "README.md", ["server.ts"])).toBe(
      "src/App.tsx",
    );
    expect(
      nextUnviewedFilePath(files, "src/App.tsx", ["server.ts", "README.md"]),
    ).toBeNull();
    expect(nextUnviewedFilePath(files, "missing", [])).toBeNull();
  });
});

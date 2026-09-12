import { describe, expect, it } from "vitest";
import {
  adjacentFilePath,
  filterChangedFiles,
  nextUnviewedFilePath,
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

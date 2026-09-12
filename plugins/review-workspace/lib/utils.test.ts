import { describe, expect, it } from "vitest";

import { compactPath, normalizeChangeKind } from "./utils.js";

describe("compactPath", () => {
  it("returns short paths unchanged", () => {
    expect(compactPath("src/app.tsx", 40)).toBe("src/app.tsx");
  });

  it("returns the input unchanged when maxLength is too small to be useful", () => {
    expect(compactPath("a/b/c.ts", 3)).toBe("a/b/c.ts");
  });

  it("abbreviates the earliest directory segments to single characters", () => {
    expect(
      compactPath("components/really/deeply/nested/folder/thing.tsx", 24),
    ).toBe("c/r/d/n/folder/thing.tsx");
  });

  it("keeps the filename and abbreviates only as much as needed", () => {
    expect(compactPath("components/really/deep/file.tsx", 26)).toBe(
      "c/really/deep/file.tsx",
    );
  });

  it("middle-truncates when even the filename exceeds the budget", () => {
    const result = compactPath("a".repeat(60), 20);
    expect(result.length).toBe(20);
    expect(result).toContain("…");
  });
});

describe("normalizeChangeKind", () => {
  it("normalizes word and letter forms case-insensitively", () => {
    expect(normalizeChangeKind("added")).toBe("added");
    expect(normalizeChangeKind("ADDED")).toBe("added");
    expect(normalizeChangeKind("A")).toBe("added");
    expect(normalizeChangeKind("deleted")).toBe("deleted");
    expect(normalizeChangeKind("D")).toBe("deleted");
    expect(normalizeChangeKind("renamed")).toBe("renamed");
    expect(normalizeChangeKind("R")).toBe("renamed");
    expect(normalizeChangeKind("modified")).toBe("modified");
    expect(normalizeChangeKind("M")).toBe("modified");
    expect(normalizeChangeKind("m")).toBe("modified");
    expect(normalizeChangeKind("something-else")).toBe("modified");
  });
});

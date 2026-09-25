import { describe, expect, it } from "vitest";
import { toHoardItem } from "./hoard-item";

describe("real hoard projection", () => {
  it("preserves stored kinds while labeling old articles accurately", () => {
    const item = toHoardItem({ id: "itm_example", sourceId: null, source: "Example", sourceColor: "#64748b", kind: "repo", author: null, title: "Old repo", excerpt: "Preview only", url: "https://example.org/old", publishedAt: 1072915200, tags: "[]", state: "new", contentState: "staged", expiresAt: null });
    expect(item).toMatchObject({ kind: "repo", day: "older", body: "Preview only", contentState: "staged", expiresAt: null });
  });
});

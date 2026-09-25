import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createContentStore } from "./content-store";
import { reconcileLinks } from "./reconcile-links";

describe("vault reconciliation", () => {
  it("removes archived links, records known failures, and creates a daily index without touching article bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "jomo-reconcile-"));
    const inbox = join(root, "Inbox");
    const library = join(root, "Library");
    await mkdir(inbox);
    const linksFile = join(inbox, "LINKS.md");
    await writeFile(linksFile, "## QUEUE\n- https://example.org/good\n- https://example.org/bad\n- https://example.org/later\n\n## FAILED\n\n## 2026-09-15\n- old entry\n");
    const store = createContentStore({ contentRoot: library, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    const id = "itm_test123";
    const path = await store.write({ id, site: "Example", sourceId: null, source: "https://example.org/good", title: "Good story", kind: "article", published: "2026-09-24T10:00:00Z", retrieved: "2026-09-24T11:00:00Z", tags: [], state: "saved", note: "", body: "Body stays here" });
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    db.prepare("INSERT INTO items (id, display_source, kind, title, excerpt, url, published_at, state, content_path, content_state) VALUES (?, 'Example', 'article', 'Good story', '', 'https://example.org/good', 1790244000, 'saved', ?, 'ready')").run(id, path);
    const result = await reconcileLinks(db, linksFile, library, "2026-09-24", { "https://example.org/bad": "HTTP 401" });
    expect(result).toEqual({ archived: 1, failed: 1, remaining: 1, indexed: 1 });
    const updated = await readFile(linksFile, "utf8");
    expect(updated).toContain("## QUEUE\n- https://example.org/later");
    expect(updated).toContain("- https://example.org/bad — HTTP 401");
    expect(updated).toContain("## 2026-09-15\n- old entry");
    expect(await readFile(join(library, path), "utf8")).toContain("Body stays here");
    const index = await readFile(join(library, "_index", "2026-09-24.md"), "utf8");
    expect(index).toContain(`../${path}`);
    expect(await reconcileLinks(db, linksFile, library, "2026-09-24", {})).toEqual({ archived: 0, failed: 0, remaining: 1, indexed: 0 });
    expect(await readFile(join(library, "_index", "2026-09-24.md"), "utf8")).toBe(index);
    await harness.lifecycle.dispose();
  });
});

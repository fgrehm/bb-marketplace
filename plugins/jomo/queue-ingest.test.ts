import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createContentStore } from "./content-store";
import { ingestQueue, parseQueue } from "./queue-ingest";
import { reconcileLinks } from "./reconcile-links";

describe("inbox link ingestion", () => {
  it("reads only QUEUE URLs, deduplicating repeat lines", () => {
    expect(parseQueue("## QUEUE\n- https://example.org/a\n- https://example.org/a\n\n## FAILED\n- https://example.org/b — 403\n")).toEqual(["https://example.org/a"]);
  });

  it("recovers a JOMO file left after a crash before ready", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const root = await mkdtemp(join(tmpdir(), "jomo-recover-"));
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    const url = "https://example.org/a";
    const id = `itm_${(await import("node:crypto")).createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
    db.prepare("INSERT INTO items (id, display_source, kind, title, excerpt, url, published_at) VALUES (?, 'Example', 'article', 'Actual story', '', ?, 1790164800)").run(id, url);
    await store.write({ id, site: "Example", sourceId: null, source: url, title: "Actual story", kind: "article", published: "2026-09-23T12:00:00Z", retrieved: "2026-09-23T12:00:00Z", tags: [], state: "new", body: "Body" });
    const result = await ingestQueue(db, store, `## QUEUE\n- ${url}\n`, async () => ({ title: "Actual story", site: "Example", published: "2026-09-23T12:00:00Z", body: "Body" }), 10, undefined, undefined, 0);
    expect(result.ingested).toBe(1);
    expect((db.prepare("SELECT content_state AS state FROM items WHERE id = ?").get(id) as { state: string }).state).toBe("ready");
    await harness.lifecycle.dispose();
  });

  it("promotes a queued RSS review row through the shared article pipeline", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const root = await mkdtemp(join(tmpdir(), "jomo-rss-queued-"));
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    db.prepare("INSERT INTO sources (id, name, url, kind, color, enabled, created_at) VALUES ('src_rss', 'Example Feed', 'https://example.org/feed', 'rss', '#000', 1, 1)").run();
    db.prepare("INSERT INTO items (id, source_id, display_source, kind, title, excerpt, url, published_at, state, content_state) VALUES ('itm_rss_queue', 'src_rss', 'Example Feed', 'article', 'Feed title', 'Feed excerpt', 'https://example.org/story', 1790164800, 'later', 'staged')").run();
    const result = await ingestQueue(db, store, "## QUEUE\n- https://example.org/story\n", async () => ({ title: "Article page", site: "Example", body: "Article body" }), 10, undefined, undefined, 0);
    expect(result).toMatchObject({ ingested: 1, failed: [] });
    expect(db.prepare("SELECT id, source_id AS sourceId, display_source AS source, state, content_state AS contentState, published_at AS publishedAt FROM items WHERE url = 'https://example.org/story'").get()).toEqual({ id: "itm_rss_queue", sourceId: "src_rss", source: "Example", state: "saved", contentState: "ready", publishedAt: 1790164800 });
    await harness.lifecycle.dispose();
  });

  it("writes pending → file → ready for new links without changing the queue", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const root = await mkdtemp(join(tmpdir(), "jomo-queue-"));
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    const text = "## QUEUE\n- https://example.org/a\n- https://example.org/a\n\n## FAILED\n- https://example.org/b — 403\n";
    let fetched = 0;
    const extractor = async () => { fetched++; return { title: "Actual story", site: "Example", author: "Writer", published: "2026-09-23T12:00:00Z", body: "# Real content" }; };
    const first = await ingestQueue(db, store, text, extractor, 10, undefined, undefined, 0);
    expect(first).toEqual({ queued: 1, ingested: 1, alreadyPresent: 0, failed: [] });
    expect((db.prepare("SELECT state, content_state AS contentState FROM items WHERE url = ?").get("https://example.org/a") as { state: string; contentState: string })).toEqual({ state: "saved", contentState: "ready" });
    const saved = await harness.behavior.callRpc("library_list", { offset: 0 }) as { items: Array<{ url: string | null }> };
    expect(saved.items.some((item) => item.url === "https://example.org/a")).toBe(true);
    const path = (db.prepare("SELECT content_path AS path FROM items WHERE url = ?").get("https://example.org/a") as { path: string }).path;
    expect(await readFile(join(root, path), "utf8")).toContain("# Real content");
    expect(await ingestQueue(db, store, text, extractor, 10)).toEqual({ queued: 1, ingested: 0, alreadyPresent: 1, failed: [] });
    expect(fetched).toBe(1);
    await harness.lifecycle.dispose();
  });
});

describe("url normalization parity", () => {
  it("dedupes a utm variant of an already-saved article", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const root = await mkdtemp(join(tmpdir(), "jomo-dedupe-"));
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    db.prepare("INSERT INTO items (id, display_source, kind, title, excerpt, url, published_at, state, content_state, content_origin) VALUES ('itm_clean1', 'Example', 'article', 'Clean', '', 'https://example.org/a', 1790000000, 'saved', 'ready', 'jomo')").run();
    const result = await ingestQueue(db, store, "## QUEUE\n- https://example.org/a?utm_source=x&utm_medium=rss\n", async () => ({ title: "Clean", site: "Example", body: "Body" }), 10, undefined, undefined, 0);
    expect(result).toMatchObject({ ingested: 0, alreadyPresent: 1 });
    await harness.lifecycle.dispose();
  });
});

describe("redirect resolution for fresh queue links", () => {
  it("archives a shortlink under its final URL and dedupes against the resolved row", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const root = await mkdtemp(join(tmpdir(), "jomo-redirect-"));
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    const extractor = async (url: string) => ({ title: "Short story", site: "Example", body: "Body" });
    const resolver = async (url: string) => url.replace("https://short.example/x", "https://real.example/article");

    // Shortlink with no stored match archives under the resolved URL.
    const first = await ingestQueue(db, store, "## QUEUE\n- https://short.example/x\n", extractor, 10, undefined, undefined, 0, resolver);
    expect(first.ingested).toBe(1);
    expect((db.prepare("SELECT url FROM items WHERE title = 'Short story'").get() as { url: string }).url).toBe("https://real.example/article");

    // The clean URL afterwards is recognized as the same article.
    const second = await ingestQueue(db, store, "## QUEUE\n- https://real.example/article\n", extractor, 10, undefined, undefined, 0, resolver);
    expect(second).toMatchObject({ ingested: 0, alreadyPresent: 1 });
    await harness.lifecycle.dispose();
  });
});

describe("redirect alias bookkeeping", () => {
  it("retires the original queue line after archiving under the resolved URL", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const root = await mkdtemp(join(tmpdir(), "jomo-alias-"));
    const linksFile = join(root, "LINKS.md");
    await writeFile(linksFile, "## QUEUE\n- https://short.example/x\n\n## FAILED\n");
    await harness.behavior.setSettings({ contentRoot: root, inboxLinksFile: linksFile });
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    const extractor = async () => ({ title: "Short story", site: "Example", body: "Body" });
    const resolver = async (url: string) => url.replace("https://short.example/x", "https://real.example/article");

    const first = await ingestQueue(db, store, "## QUEUE\n- https://short.example/x\n", extractor, 10, undefined, undefined, 0, resolver);
    expect(first.ingested).toBe(1);
    expect((db.prepare("SELECT url FROM items WHERE title = 'Short story'").get() as { url: string }).url).toBe("https://real.example/article");

    // Reconciliation must retire the original shortlink line, not leave it queued.
    const receipt = await reconcileLinks(db, linksFile, root, new Date().toISOString().slice(0, 10));
    expect(receipt.remaining).toBe(0);
    expect(await readFile(linksFile, "utf8")).not.toContain("https://short.example/x");
    await harness.lifecycle.dispose();
  });

  it("registers the alias when the resolved URL is already in the Library", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const root = await mkdtemp(join(tmpdir(), "jomo-alias-dup-"));
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    db.prepare("INSERT INTO items (id, display_source, kind, title, excerpt, url, published_at, state, content_state, content_origin) VALUES ('itm_real1', 'Example', 'article', 'Short story', '', 'https://real.example/article', 1790000000, 'saved', 'ready', 'jomo')").run();
    const result = await ingestQueue(db, store, "## QUEUE\n- https://short.example/x\n", async () => ({ title: "Short story", site: "Example", body: "Body" }), 10, undefined, undefined, 0, async (url) => url.replace("https://short.example/x", "https://real.example/article"));
    expect(result).toMatchObject({ ingested: 0, alreadyPresent: 1 });
    expect((db.prepare("SELECT url FROM url_aliases WHERE alias = 'https://short.example/x'").get() as { url: string }).url).toBe("https://real.example/article");
    await harness.lifecycle.dispose();
  });
});

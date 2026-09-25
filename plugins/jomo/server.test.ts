import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentStore } from "./content-store";
import plugin, { DEFAULT_CONTENT_ROOT } from "./server";

const validFeedFetch = () => vi.stubGlobal("fetch", vi.fn(async () => new Response('<?xml version="1.0"?><rss><channel><item><title>A story</title><link>https://example.org/a</link><guid>g</guid></item></channel></rss>', { headers: { "content-type": "application/rss+xml" } })));

describe("JOMO storage cutover", () => {
  it("drains only newly staged entries after their staging-based 30 days", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare("INSERT INTO items (id, display_source, kind, title, published_at, state, content_state, expires_at) VALUES (?, 'Example', 'article', ?, 1, 'new', 'staged', ?)");
    insert.run("legacy", "Old but exempt", null);
    insert.run("expired", "Staged over 30 days ago", now - 1);
    insert.run("waiting", "Still waiting", now + 86400);
    await harness.behavior.callRpc("rss_review_list", { offset: 0 });
    expect(db.prepare("SELECT id, state, drained_at AS drainedAt FROM items ORDER BY id").all()).toEqual([
      { id: "expired", state: "dropped", drainedAt: expect.any(Number) },
      { id: "legacy", state: "new", drainedAt: null },
      { id: "waiting", state: "new", drainedAt: null },
    ]);
    await harness.lifecycle.dispose();
  });

  it("loads reader items without exposing dropped rows or full bodies", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const insert = db.prepare("INSERT INTO items (id, display_source, kind, title, excerpt, url, published_at, state, content_state) VALUES (?, 'Example', 'article', ?, 'Preview', ?, ?, ?, 'staged')");
    for (let i = 0; i < 27; i++) insert.run(`rss_${i}`, `Story ${i}`, `https://example.org/${i}`, 2000 - i, i === 26 ? "dropped" : "new");
    expect(await harness.behavior.callRpc("item_get", { id: "rss_25" })).toMatchObject({ item: { id: "rss_25", excerpt: "Preview", state: "new" } });
    expect(await harness.behavior.callRpc("item_get", { id: "rss_26" })).toEqual({ item: null });
    db.prepare("UPDATE items SET state = 'saved', content_state = 'ready' WHERE id = 'rss_25'").run();
    expect(await harness.behavior.callRpc("item_get", { id: "rss_25" })).toMatchObject({ item: { id: "rss_25", state: "saved" } });
    await harness.lifecycle.dispose();
  });

  it("lists persisted library rows without bodies, and opens the content file on demand", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    db.prepare("INSERT INTO items (id, display_source, kind, title, excerpt, url, published_at, state, content_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("itm_one", "Example", "article", "A real article", "A short excerpt", "https://example.org/a", 1790000000, "saved", "missing");
    expect(await harness.behavior.callRpc("library_list", { offset: 0 })).toEqual({ items: [{ id: "itm_one", source: "Example", kind: "article", title: "A real article", excerpt: "A short excerpt", url: "https://example.org/a", publishedAt: 1790000000, contentState: "missing" }], hasMore: false });
    expect(await harness.behavior.callRpc("library_read", { id: "itm_one" })).toEqual({ body: null, missing: true });
    expect(await harness.behavior.callRpc("library_list", { offset: 0, state: "new" })).toEqual({ items: [], hasMore: false });
    const root = await mkdtemp(join(tmpdir(), "jomo-library-"));
    await harness.behavior.setSettings({ contentRoot: root });
    const path = await createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" }).write({ id: "itm_one123", site: "Example", sourceId: null, source: "https://example.org/a", title: "A real article", kind: "article", published: "2026-09-23", retrieved: "2026-09-23", tags: [], state: "saved", body: "Real content" });
    db.prepare("UPDATE items SET content_path = ?, content_state = 'ready' WHERE id = ?").run(path, "itm_one");
    expect(await harness.behavior.callRpc("library_read", { id: "itm_one" })).toEqual({ body: "Real content", missing: false });
    await harness.lifecycle.dispose();
  });

  it("imports vault files through the server CLI while leaving the files unchanged", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    const root = await mkdtemp(join(tmpdir(), "jomo-import-"));
    await mkdir(join(root, "example.org"));
    const path = join(root, "example.org", "2026-09-23-a-real-article.md");
    const original = '---\ntitle: "A real article"\nsite: "Example"\nsource: "https://example.org/a"\npublished: 2026-09-23\n---\n\nReal content';
    await writeFile(path, original);
    await plugin(bb);
    await harness.behavior.setSettings({ contentRoot: root });
    expect((await harness.behavior.runCli(["import-library", "--dry-run"])).exitCode).toBe(0);
    expect((bb.storage.database().prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(0);
    expect((await harness.behavior.runCli(["import-library", "--apply"])).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["import-library", "--apply"])).exitCode).toBe(0);
    expect((bb.storage.database().prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(1);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path, "utf8")).toBe(original);
    const list = await harness.behavior.callRpc("library_list", { offset: 0 }) as { items: Array<{ id: string }> };
    expect(await harness.behavior.callRpc("library_read", { id: list.items[0].id })).toEqual({ body: "Real content", missing: false });
    await harness.lifecycle.dispose();
  });

  it("adds feeds paused after a validating probe and queues captured links", async () => {
    validFeedFetch();
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    const root = await mkdtemp(join(tmpdir(), "jomo-capture-"));
    const inboxLinksFile = join(root, "LINKS.md");
    await writeFile(inboxLinksFile, "## QUEUE\n\n## FAILED\n");
    await plugin(bb);
    await harness.behavior.setSettings({ inboxLinksFile });
    const added = await harness.behavior.callRpc("rss_source_add", { name: "Example", url: "https://example.org/feed" }) as { id: string };
    const sources = await harness.behavior.callRpc("rss_sources_list", {}) as { sources: Array<{ id: string; enabled: boolean }> };
    expect(sources.sources.find((source) => source.id === added.id)).toMatchObject({ enabled: false });
    expect(await harness.behavior.callRpc("queue_link", { url: "https://example.org/one" })).toEqual({ added: true });
    expect(await harness.behavior.callRpc("queue_link", { url: "https://example.org/one" })).toEqual({ added: false });
    expect(await readFile(inboxLinksFile, "utf8")).toContain("https://example.org/one");
    vi.unstubAllGlobals();
    await harness.lifecycle.dispose();
  });

  it("previews the configured Inbox queue for the mobile UI", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    const root = await mkdtemp(join(tmpdir(), "jomo-mobile-"));
    const file = join(root, "LINKS.md");
    await writeFile(file, "## QUEUE\n- https://example.org/a\n- https://example.org/a\n\n## FAILED\n- https://example.org/b — 403\n");
    await plugin(bb);
    await harness.behavior.setSettings({ inboxLinksFile: file });
    expect(await harness.behavior.callRpc("queue_preview", {})).toEqual({ queued: 1 });
    await writeFile(file, "## QUEUE\n\n## FAILED\n");
    await harness.behavior.setSettings({ contentRoot: join(root, "Library") });
    const legacy = Date.parse("2026-09-24T01:44:15.684Z");
    bb.storage.database().prepare("INSERT INTO queue_jobs (id, started_at, status, queued, processed, failures_json, failed_count) VALUES (?, ?, 'completed', 89, 89, ?, 89)").run("job_legacy", legacy, JSON.stringify([{ url: "Steve Yegge — essays", reason: "ParserConstructor is not a constructor" }]));
    bb.storage.database().prepare("INSERT INTO queue_jobs (id, started_at, status, queued, processed, failures_json, failed_count) VALUES (?, ?, 'completed', 89, 89, ?, 89)").run("job_legacy_older", Date.parse("2026-09-23T00:00:00Z"), JSON.stringify([{ url: "TechCrunch", reason: "_rssParser.default is not a constructor" }]));
    expect(await harness.behavior.callRpc("queue_status", {})).toEqual({ job: null });
    const started = await harness.behavior.callRpc("queue_start", {}) as { jobId: string; queued: number };
    expect(started.queued).toBe(0);
    const status = await harness.behavior.callRpc("queue_status", {}) as { job: { id: string; status: string } };
    expect(status.job.id).toBe(started.jobId);
    expect(["running", "completed"]).toContain(status.job.status);
    await harness.lifecycle.dispose();
  });

  it("runs the entire queue in a persistent background job, not a three-link batch", async () => {
    const previousDelay = process.env.JOMO_BATCH_DELAY_MS;
    process.env.JOMO_BATCH_DELAY_MS = "0";
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    const root = await mkdtemp(join(tmpdir(), "jomo-all-"));
    const file = join(root, "LINKS.md");
    const urls = Array.from({ length: 5 }, (_, index) => `https://example.org/${index}`);
    await writeFile(file, `## QUEUE\n${urls.map((url) => `- ${url}`).join("\n")}\n\n## FAILED\n`);
    await plugin(bb);
    const db = bb.storage.database();
    const insert = db.prepare("INSERT INTO items (id, display_source, kind, title, excerpt, url, published_at, state, content_path, content_state, content_origin) VALUES (?, 'Example', 'article', 'Existing', '', ?, 1790000000, 'saved', 'existing.md', 'ready', 'imported')");
    urls.forEach((url, index) => insert.run(`itm_existing${index}`, url));
    await harness.behavior.setSettings({ inboxLinksFile: file, contentRoot: join(root, "Library") });
    const started = await harness.behavior.callRpc("queue_start", {}) as { queued: number };
    expect(started.queued).toBe(5);
    type QueueJobShape = { status: string; processed: number; alreadyPresent: number } | null;
    let job: QueueJobShape = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      job = ((await harness.behavior.callRpc("queue_status", {})) as { job: QueueJobShape }).job;
      if (job?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job).toMatchObject({ status: "completed", processed: 5, alreadyPresent: 5 });
    expect((await readFile(file, "utf8")).match(/^- https?:\/\//gm)).toBeNull();
    process.env.JOMO_BATCH_DELAY_MS = previousDelay;
    await harness.lifecycle.dispose();
  });

  it("saves a JOMO-owned ready item without fetching it again", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const root = await mkdtemp(join(tmpdir(), "jomo-ready-save-"));
    const file = join(root, "LINKS.md");
    await writeFile(file, "## QUEUE\n\n## FAILED\n");
    await harness.behavior.setSettings({ contentRoot: root, inboxLinksFile: file });
    const id = "itm_ready123";
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    const path = await store.write({ id, site: "Example", sourceId: null, source: "https://example.org/ready", title: "Ready", kind: "article", published: "2026-09-23", retrieved: "2026-09-23", tags: [], state: "new", body: "Ready content" });
    bb.storage.database().prepare("INSERT INTO items (id, display_source, kind, title, url, published_at, content_state, content_path) VALUES (?, 'Example', 'article', 'Ready', 'https://example.org/ready', 1, 'ready', ?)").run(id, path);
    expect(await harness.behavior.callRpc("rss_action", { id, action: "save" })).toEqual({ outcome: "saved" });
    expect((bb.storage.database().prepare("SELECT state FROM items WHERE id = ?").get(id) as { state: string }).state).toBe("saved");
    expect(await store.readBody(path)).toBe("Ready content");
    await harness.lifecycle.dispose();
  });

  it("removes legacy item-note storage while preserving settings and profile data", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await bb.storage.kv.set("librarian-profile", { marker: "preserve" });
    await plugin(bb);
    expect(DEFAULT_CONTENT_ROOT).toBe("/data/obsidian/Agent/Library");
    expect(bb.storage.database().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'item_notes'").get()).toBeUndefined();
    expect((bb.storage.database().prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>).some(({ name }) => name === "paused_note")).toBe(false);
    await harness.behavior.setSettings({ filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    await harness.behavior.setSettings({ contentRoot: "/tmp/jomo-content", filenamePattern: "{{slug}}-{{idSuffix}}.md", pruneDrainedFiles: false });
    expect(await bb.storage.kv.get("librarian-profile")).toEqual({ marker: "preserve" });
    await harness.lifecycle.dispose();
  });

  it("filters review rows by source while retaining global source counts", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    db.prepare("INSERT INTO sources (id, name, url, kind, color, enabled, created_at) VALUES ('src_a', 'Alpha', 'https://alpha.example/feed', 'rss', '#000', 1, 1), ('src_b', 'Beta', 'https://beta.example/feed', 'rss', '#000', 1, 1)").run();
    const insert = db.prepare("INSERT INTO items (id, source_id, display_source, kind, title, excerpt, url, published_at, state, content_state) VALUES (?, ?, ?, 'article', ?, 'Preview', ?, ?, 'new', 'staged')");
    insert.run("itm_alpha", "src_a", "Alpha", "Alpha story", "https://alpha.example/story", 2000);
    insert.run("itm_beta", "src_b", "Beta", "Beta story", "https://beta.example/story", 1000);
    const all = await harness.behavior.callRpc("rss_review_list", { offset: 0 }) as { total: number; allTotal: number; sources: Array<{ id: string; count: number }> };
    expect(all).toMatchObject({ total: 2, allTotal: 2, sources: [{ id: "src_a", count: 1 }, { id: "src_b", count: 1 }] });
    const filtered = await harness.behavior.callRpc("rss_review_list", { offset: 0, sourceId: "src_b" }) as { total: number; allTotal: number; items: Array<{ source: string }>; sources: Array<{ id: string; count: number }> };
    expect(filtered).toMatchObject({ total: 1, allTotal: 2, items: [{ source: "Beta" }], sources: [{ id: "src_a", count: 1 }, { id: "src_b", count: 1 }] });
    await harness.lifecycle.dispose();
  });

  it("stages feed entries only after an explicit fetch request", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    db.prepare("INSERT INTO sources (id, name, url, kind, color, enabled, created_at) VALUES ('src_test', 'Example Feed', 'https://example.org/feed', 'rss', '#000', 1, 1)").run();
    const fetchMock = vi.fn(async () => new Response(`<?xml version="1.0"?><rss><channel><item><title>A real story</title><link>https://example.org/story</link><guid>story-1</guid><description><![CDATA[A brief feed excerpt.]]></description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(fetchMock).not.toHaveBeenCalled();
      const started = await harness.behavior.callRpc("rss_sync_start", {}) as { jobId: string; queued: number };
      expect(started.queued).toBe(1);
      type SyncJobShape = { status: string; staged: number } | null;
      let job: SyncJobShape = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        job = ((await harness.behavior.callRpc("rss_sync_status", {})) as { job: SyncJobShape }).job;
        if (job?.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(job).toMatchObject({ status: "completed", staged: 1 });
      expect(await harness.behavior.callRpc("rss_review_list", { offset: 0 })).toMatchObject({ total: 1, items: [{ source: "Example Feed", title: "A real story", excerpt: "A brief feed excerpt." }] });
      expect(db.prepare("SELECT content_path AS path, content_state AS state FROM items WHERE url = 'https://example.org/story'").get()).toEqual({ path: null, state: "staged" });
    } finally {
      vi.unstubAllGlobals();
      await harness.lifecycle.dispose();
    }
  });

  it("adds and pauses feed sources from the phone-facing RSS surface", async () => {
    validFeedFetch();
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const result = await harness.behavior.callRpc("rss_source_add", { name: "Example Feed", url: "https://example.org/feed.xml" }) as { id: string; added: boolean };
    expect(result.added).toBe(true);
    expect(await harness.behavior.callRpc("rss_source_add", { name: "Duplicate", url: "https://example.org/feed.xml" })).toEqual({ id: result.id, added: false });
    expect(await harness.behavior.callRpc("rss_source_set_enabled", { id: result.id, enabled: false })).toEqual({ saved: true });
    expect(await harness.behavior.callRpc("rss_sources_list", {})).toEqual({ sources: [{ id: result.id, name: "Example Feed", url: "https://example.org/feed.xml", kind: "rss", color: "#64748b", enabled: false, lastFetchedAt: null }] });
    await expect(harness.behavior.callRpc("rss_source_add", { name: "Unsafe", url: "file:///etc/passwd" })).rejects.toThrow("Feed URLs must use HTTP(S)");
    vi.unstubAllGlobals();
    await harness.lifecycle.dispose();
  });

  it("uses one review action to save, queue, or discard staged RSS entries", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    const root = await mkdtemp(join(tmpdir(), "jomo-rss-actions-"));
    const linksFile = join(root, "LINKS.md");
    await writeFile(linksFile, "## QUEUE\n\n## FAILED\n");
    await plugin(bb);
    await harness.behavior.setSettings({ inboxLinksFile: linksFile, contentRoot: join(root, "Library") });
    const db = bb.storage.database();
    db.prepare("INSERT INTO sources (id, name, url, kind, color, enabled, created_at) VALUES ('src_test', 'Example Feed', 'https://example.org/feed', 'rss', '#000', 1, 1)").run();
    const insert = db.prepare("INSERT INTO items (id, source_id, display_source, kind, title, excerpt, url, published_at, state, content_state) VALUES (?, 'src_test', 'Example Feed', 'article', ?, 'Feed excerpt', ?, ?, 'new', 'staged')");
    insert.run("itm_rss_save1", "Save me", "https://example.org/save", Math.floor(Date.now() / 1000));
    insert.run("itm_rss_queue1", "Queue me", "https://example.org/queue", Math.floor(Date.now() / 1000));
    insert.run("itm_rss_drop1", "Discard me", "https://example.org/drop", Math.floor(Date.now() / 1000));
    vi.stubGlobal("fetch", async (input: string | URL | Request) => { const title = String(input).includes("/queue") ? "Queued article" : "Saved article"; return new Response(`<html><head><title>${title}</title></head><body><main><article><h1>${title}</h1><p>This is the source page body with enough real text for extraction.</p></article></main></body></html>`, { headers: { "content-type": "text/html" } }); });
    try {
      expect(await harness.behavior.callRpc("rss_action", { id: "itm_rss_save1", action: "save" })).toEqual({ outcome: "saved" });
      expect(await harness.behavior.callRpc("rss_action", { id: "itm_rss_queue1", action: "queue" })).toEqual({ outcome: "queued" });
      expect(await harness.behavior.callRpc("rss_action", { id: "itm_rss_drop1", action: "discard" })).toEqual({ outcome: "discarded" });
      expect((db.prepare("SELECT state, content_state AS contentState, content_path AS path FROM items WHERE id = 'itm_rss_save1'").get() as { state: string; contentState: string; path: string | null })).toMatchObject({ state: "saved", contentState: "ready" });
      expect((db.prepare("SELECT state FROM items WHERE id = 'itm_rss_queue1'").get() as { state: string }).state).toBe("later");
      expect((db.prepare("SELECT state FROM items WHERE id = 'itm_rss_drop1'").get() as { state: string }).state).toBe("dropped");
      expect(await readFile(linksFile, "utf8")).toContain("- https://example.org/queue");
      expect(await harness.behavior.callRpc("rss_action", { id: "itm_rss_queue1", action: "save" })).toEqual({ outcome: "saved" });
      expect((db.prepare("SELECT state FROM items WHERE id = 'itm_rss_queue1'").get() as { state: string }).state).toBe("saved");
      expect(await readFile(linksFile, "utf8")).not.toContain("- https://example.org/queue");
      expect(await harness.behavior.callRpc("rss_review_list", { offset: 0 })).toMatchObject({ total: 0, items: [] });
    } finally {
      vi.unstubAllGlobals();
      await harness.lifecycle.dispose();
    }
  });
});

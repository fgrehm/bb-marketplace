import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { parseFeedXml, stageFeedEntries, type FeedEntry } from "./feed-sync";

describe("RSS staging", () => {
  it("parses RSS and Atom entries without turning feed excerpts into saved content", () => {
    expect(parseFeedXml(`<?xml version="1.0"?><rss><channel><item><title>A story</title><link>https://example.org/a</link><guid>entry-a</guid><pubDate>Tue, 24 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Short excerpt</p>]]></description></item></channel></rss>`)).toEqual([
      { guid: "entry-a", url: "https://example.org/a", title: "A story", author: null, publishedAt: Math.floor(Date.parse("2026-09-24T10:00:00Z") / 1000), excerpt: "Short excerpt", tags: [] },
    ]);
    expect(parseFeedXml(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:example.org,2026:a</id><title>Atom story</title><link href="https://example.org/atom" rel="alternate"/><updated>2026-09-24T11:00:00Z</updated><summary>Atom summary</summary><author><name>Writer</name></author></entry></feed>`)[0]).toMatchObject({ guid: "tag:example.org,2026:a", url: "https://example.org/atom", title: "Atom story", author: "Writer", excerpt: "Atom summary" });
  });

  it("rejects successful HTTP responses that are not RSS or Atom documents", () => {
    expect(() => parseFeedXml("<html><body>Not a feed</body></html>")).toThrow("Unrecognized RSS or Atom document");
  });

  it("stages eligible entries in SQLite once and records seen GUIDs without content files", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    const sourceId = "src_example";
    db.prepare("INSERT INTO sources (id, name, url, kind, color, enabled, created_at) VALUES (?, ?, ?, 'rss', '#000', 1, 1)").run(sourceId, "Example", "https://example.org/feed");
    const entries: FeedEntry[] = [
      { guid: "new", url: "https://example.org/new", title: "New story", author: null, publishedAt: 1790244000, excerpt: "Feed excerpt", tags: [] },
      { guid: "old", url: "https://example.org/old", title: "Old story", author: null, publishedAt: 1, excerpt: "Old excerpt", tags: [] },
    ];
    const first = stageFeedEntries(db, { id: sourceId, name: "Example" }, entries, 1790244000);
    const retry = stageFeedEntries(db, { id: sourceId, name: "Example" }, entries, 1790244000);
    expect(first).toEqual({ staged: 2, duplicates: 0 });
    expect(retry).toEqual({ staged: 0, duplicates: 2 });
    expect(db.prepare("SELECT title, excerpt, content_state AS contentState, content_path AS contentPath, state FROM items").all()).toEqual([
      { title: "New story", excerpt: "Feed excerpt", contentState: "staged", contentPath: null, state: "new" },
      { title: "Old story", excerpt: "Old excerpt", contentState: "staged", contentPath: null, state: "new" },
    ]);
    expect(db.prepare("SELECT expires_at AS expiresAt FROM items ORDER BY title").all()).toEqual([{ expiresAt: 1790244000 + 30 * 86400 }, { expiresAt: 1790244000 + 30 * 86400 }]);
    expect(db.prepare("SELECT guid FROM seen_entries ORDER BY guid").all()).toEqual([{ guid: "new" }, { guid: "old" }]);
    await harness.lifecycle.dispose();
  });
});

describe("feed categories", () => {
  it("maps RSS and Atom categories into staged tags", () => {
    const rss = `<rss><channel><item><title>RSS one</title><link>https://example.org/one</link><guid>g1</guid><category>Go</category><category>Software</category></item></channel></rss>`;
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>a1</id><title>Atom one</title><link href="https://example.org/two" rel="alternate"/></entry></feed>`;
    const [rssEntry] = parseFeedXml(rss);
    expect(rssEntry.tags).toEqual(["Go", "Software"]);
    const atomEntries = parseFeedXml(`<feed><entry><id>a1</id><title>Atom one</title><link href="https://example.org/two" rel="alternate"/><category term="Elixir"/></entry></feed>`);
    expect(atomEntries[0].tags).toEqual(["Elixir"]);
    expect(atomEntries.length).toBe(1);
  });

  it("stores feed tags on staged items", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jomo" });
    await plugin(bb);
    const db = bb.storage.database();
    db.prepare("INSERT INTO sources (id, name, url, kind, color, enabled, created_at) VALUES ('src_cat', 'Example', 'https://example.org/feed', 'rss', '#000', 1, 1)").run();
    const entries: FeedEntry[] = [{ guid: "tagged", url: "https://example.org/tagged", title: "Tagged", author: null, publishedAt: 1, excerpt: "x", tags: ["Go", "Software"] }];
    const result = stageFeedEntries(db, { id: "src_cat", name: "Example" }, entries, 1);
    expect(result.staged).toBe(1);
    expect((db.prepare("SELECT tags FROM items WHERE url = 'https://example.org/tagged'").get() as { tags: string }).tags).toBe('["Go","Software"]');
    await harness.lifecycle.dispose();
  });
});

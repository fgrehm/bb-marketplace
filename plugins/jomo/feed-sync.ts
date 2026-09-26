import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { XMLParser } from "fast-xml-parser";
import { normalizeUrl } from "./normalize-url";

export type FeedEntry = { guid: string; url: string; title: string; author: string | null; publishedAt: number; excerpt: string; tags: string[] };
type FeedSource = { id: string; name: string; url?: string };
type XmlRecord = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  parseTagValue: false,
  trimValues: true,
});

function asRecord(value: unknown): XmlRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as XmlRecord : null;
}

function asArray(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function decodeXml(value: string): string {
  return value.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (entity, numeric: string | undefined, named: string | undefined) => {
    if (numeric) {
      const codepoint = numeric[0]?.toLowerCase() === "x" ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
      return Number.isFinite(codepoint) && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : "";
    }
    const knownEntity = ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[named?.toLowerCase() ?? ""];
    return knownEntity ?? entity;
  });
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return decodeHtmlEntities(decodeXml(String(value))).trim();
  const record = asRecord(value);
  if (record && typeof record["#text"] === "string") return decodeHtmlEntities(decodeXml(record["#text"] as string)).trim();
  return "";
}

function htmlText(value: unknown): string {
  return text(value).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function atomUrl(value: unknown): string {
  for (const candidate of asArray(value)) {
    const record = asRecord(candidate);
    if (record?.["@_href"] && (!record["@_rel"] || record["@_rel"] === "alternate")) return text(record["@_href"]);
  }
  return text(value);
}

function feedItems(xml: unknown): unknown[] {
  const root = asRecord(xml);
  if (!root) return [];
  const rss = asRecord(root.rss);
  const channel = asRecord(rss?.channel);
  if (channel) return asArray(channel.item);
  const rdf = asRecord(root["rdf:RDF"]);
  if (rdf) return asArray(rdf.item);
  const atom = asRecord(root.feed);
  if (atom) return asArray(atom.entry);
  return [];
}

function entryTags(entry: XmlRecord): string[] {
  // RSS <category>Body</category> and Atom <category term="Go"/> both flow
  // into staged item tags.
  const tags = asArray(entry.category).map((value) => {
    if (typeof value === "string" || typeof value === "number") return decodeXml(String(value));
    const record = asRecord(value);
    return record ? (typeof record["@_term"] === "string" ? record["@_term"] : text(record["#text"])) : "";
  }).map((tag) => tag.trim().replace(/\s+/g, " ")).filter(Boolean);
  return [...new Set(tags)].slice(0, 8);
}

function parseFeedDocument(xml: string): unknown {
  return parser.parse(xml) as unknown;
}

function repairBareAmpersands(xml: string): string {
  // XML only permits ampersands that begin a predefined/numeric entity. Escape
  // other ampersands, including raw HTML entities like &copy;, as text.
  return xml.replace(/&(?!(?:#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos);)/gi, "&amp;");
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&copy;/gi, "©");
}

export function parseFeedXml(xml: string, now = Math.floor(Date.now() / 1000)): FeedEntry[] {
  if (xml.length > 5_000_000) throw new Error("Feed response exceeds 5 MB");
  let parsed: unknown;
  try {
    parsed = parseFeedDocument(xml);
  } catch (error) {
    const repaired = repairBareAmpersands(xml);
    if (repaired === xml) throw error;
    parsed = parseFeedDocument(repaired);
  }
  const root = asRecord(parsed);
  if (!root || !("rss" in root || "feed" in root || "rdf:RDF" in root)) throw new Error("Unrecognized RSS or Atom document");
  return feedItems(parsed).flatMap((value): FeedEntry[] => {
    const entry = asRecord(value);
    if (!entry) return [];
    const url = atomUrl(entry.link);
    let validUrl: URL;
    try { validUrl = new URL(url); } catch { return []; }
    if (validUrl.protocol !== "http:" && validUrl.protocol !== "https:") return [];
    const title = text(entry.title).slice(0, 500);
    if (!title) return [];
    const guid = text(entry.guid) || text(entry.id) || url;
    const authorValue = entry.author;
    const authorRecord = asRecord(authorValue);
    const author = text(authorRecord?.name ?? authorValue).slice(0, 200) || null;
    const dateValue = text(entry.pubDate) || text(entry.published) || text(entry.updated) || text(entry["dc:date"]);
    const timestamp = dateValue && Number.isFinite(Date.parse(dateValue)) ? Math.floor(Date.parse(dateValue) / 1000) : now;
    const excerpt = htmlText(entry.description ?? entry.summary ?? entry["content:encoded"] ?? entry.content);
    return [{ guid: guid.slice(0, 2000), url: normalizeUrl(validUrl.href), title, author, publishedAt: timestamp, excerpt, tags: entryTags(entry) }];
  });
}

function itemKind(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname === "youtu.be" || hostname.endsWith("youtube.com")) return "video";
  if (hostname === "github.com") return "repo";
  if (hostname === "x.com" || hostname.endsWith("twitter.com")) return "post";
  return "article";
}

export function stageFeedEntries(db: Database.Database, source: FeedSource, entries: FeedEntry[], now = Math.floor(Date.now() / 1000)) {
  const seen = db.prepare("INSERT OR IGNORE INTO seen_entries (source_id, guid, seen_at) VALUES (?, ?, ?)");
  const existingUrl = db.prepare("SELECT 1 FROM items WHERE url = ? LIMIT 1");
  const insert = db.prepare("INSERT OR IGNORE INTO items (id, source_id, display_source, kind, author, title, excerpt, url, published_at, tags, state, content_state, content_origin, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'staged', 'jomo', ?)");
  let staged = 0;
  let duplicates = 0;
  const run = db.transaction(() => {
    for (const entry of entries) {
      const result = seen.run(source.id, entry.guid, now);
      if (!result.changes) { duplicates++; continue; }
      if (existingUrl.get(entry.url)) { duplicates++; continue; }
      const id = `itm_${createHash("sha256").update(`${source.id}\0${entry.guid}`).digest("hex").slice(0, 24)}`;
      staged += insert.run(id, source.id, source.name, itemKind(entry.url), entry.author, entry.title, entry.excerpt, entry.url, entry.publishedAt, JSON.stringify(entry.tags), now + 30 * 86400).changes;
    }
  });
  run();
  return { staged, duplicates };
}

export async function syncFeedSources(
  db: Database.Database,
  fetcher: (url: string, signal: AbortSignal) => Promise<string>,
  onProgress?: (progress: { processed: number; staged: number; duplicates: number; failures: Array<{ source: string; reason: string }> }) => void,
  shouldStop?: () => boolean,
  signal: AbortSignal = new AbortController().signal,
) {
  const sources = db.prepare("SELECT id, name, url FROM sources WHERE enabled = 1 ORDER BY name COLLATE NOCASE, id").all() as Array<{ id: string; name: string; url: string }>;
  const result = { queued: sources.length, processed: 0, staged: 0, duplicates: 0, failures: [] as Array<{ source: string; reason: string }> };
  for (const source of sources) {
    if (shouldStop?.()) throw new Error("RSS sync interrupted");
    try {
      // Feed fetches retry with linear backoff before counting as a failure
      // Three attempts total before a feed counts as failed.
      let xml: string | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3 && xml === null; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        try { xml = await fetcher(source.url, signal); } catch (error) { lastError = error; }
      }
      if (xml === null) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      const entries = parseFeedXml(xml);
      const counts = stageFeedEntries(db, source, entries);
      result.staged += counts.staged;
      result.duplicates += counts.duplicates;
      db.prepare("UPDATE sources SET last_fetch_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), source.id);
    } catch (error) {
      result.failures.push({ source: source.name, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
    result.processed++;
    onProgress?.({ processed: result.processed, staged: result.staged, duplicates: result.duplicates, failures: result.failures });
  }
  return result;
}

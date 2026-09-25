import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type Database from "better-sqlite3";
import type { createContentStore } from "./content-store";
import { plainExcerpt } from "./excerpt-plain";
import { normalizeUrl, resolveUrl } from "./normalize-url";

export type ExtractedLink = { title: string; site: string; author?: string; published?: string; body: string; preview?: boolean };
export type ExtractLink = (url: string) => Promise<ExtractedLink>;
export type IngestEvent = { url: string; outcome: "saved" | "already_present" | "failed"; preview: boolean; reason?: string };
export type IngestProgress = { processed: number; ingested: number; alreadyPresent: number; failed: Array<{ url: string; reason: string }>; events: IngestEvent[]; current: string | null };
type Store = ReturnType<typeof createContentStore>;
type ArticleOptions = { id?: string; sourceId?: string | null; sourceName?: string; tags?: string[]; resolve?: (url: string) => Promise<string> };

export type ArticleIngestion = { id: string; path: string; alreadyPresent: boolean; preview?: boolean };

// Politeness delay between article fetches, so a batch does not hammer
// rate-limiting origins, so batches pause between requests.
const BATCH_DELAY_MS = 3_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shared article extraction and persistence path for Links and curated RSS entries. */
export async function ingestArticle(db: Database.Database, store: Store, rawUrl: string, extract: ExtractLink, options: ArticleOptions = {}): Promise<ArticleIngestion> {
  const find = (url: string, id: string) => db.prepare("SELECT id, url, content_state AS contentState, content_origin AS origin, state, deleted_file_at AS deletedFileAt, source_id AS sourceId, published_at AS publishedAt FROM items WHERE url = ? OR id = ? LIMIT 1").get(url, id) as { id: string; url: string; contentState: string; origin: string; state: string; deletedFileAt: number | null; sourceId: string | null; publishedAt: number } | undefined;
  let url = normalizeUrl(rawUrl);
  const incoming = url;
  let defaultId = options.id ?? `itm_${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
  let existing = find(url, defaultId);
  // Fresh queue links: follow redirects once so shortlinks (t.co, youtu.be)
  // archive under their final URL. Existing rows (RSS staged items) keep
  // their stored URL so queue reconciliation keeps matching.
  if (!existing && !options.id && options.resolve) {
    try {
      const resolved = normalizeUrl(await options.resolve(url));
      if (resolved !== url) {
        const resolvedId = `itm_${createHash("sha256").update(resolved).digest("hex").slice(0, 24)}`;
        const found = find(resolved, resolvedId);
        if (found) {
          existing = found;
          // The queue still holds the original URL; remember where it went so
          // reconciliation can retire the line instead of re-fetching it.
          db.prepare("INSERT OR REPLACE INTO url_aliases (alias, url) VALUES (?, ?)").run(incoming, found.url);
        } else { url = resolved; defaultId = resolvedId; }
      }
    } catch { /* unreachable or HEAD-refused: keep the incoming URL */ }
  }
  const id = existing?.id ?? defaultId;
  if (existing && (existing.contentState === "ready" || existing.origin === "imported" || existing.state === "dropped" || existing.deletedFileAt !== null)) {
    return { id, path: "", alreadyPresent: true };
  }

  const page = await extract(url);
  if (!page.title.trim() || !page.body.trim()) throw new Error("No extractable title or body");
  const now = new Date();
  // Published-date precedence: what the page says, then what the row already
  // knows (staged RSS items carry their real feed date), and only then the
  // retrieval date. Never overwrite a known publish date with "now".
  const extractedAt = page.published && Number.isFinite(Date.parse(page.published)) ? Math.floor(Date.parse(page.published) / 1000) : null;
  const publishedAt = extractedAt ?? existing?.publishedAt ?? Math.floor(now.getTime() / 1000);
  const publishedDate = new Date(publishedAt * 1000);
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const kind = /(?:youtube\.com|youtu\.be)$/.test(hostname) ? "video" : hostname === "github.com" ? "repo" : /(?:x\.com|twitter\.com)$/.test(hostname) ? "post" : "article";
  const excerpt = plainExcerpt(page.body);
  const sourceId = options.sourceId ?? existing?.sourceId ?? null;
  const sourceName = options.sourceName ?? page.site;
  const tags = options.tags ?? [];
  if (!existing) {
    db.prepare("INSERT INTO items (id, source_id, display_source, kind, author, title, excerpt, url, published_at, tags, state, expires_at, content_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'saved', NULL, 'pending')")
      .run(id, sourceId, sourceName, kind, page.author ?? null, page.title, excerpt, url, publishedAt, JSON.stringify(tags));
  } else {
    db.prepare("UPDATE items SET source_id = COALESCE(source_id, ?), display_source = ?, kind = ?, author = ?, title = ?, excerpt = ?, url = ?, published_at = ?, tags = ?, expires_at = NULL, content_state = 'pending' WHERE id = ? AND content_state IN ('pending','missing','staged') AND content_origin = 'jomo'")
      .run(sourceId, sourceName, kind, page.author ?? null, page.title, excerpt, url, publishedAt, JSON.stringify(tags), id);
  }
    const path = await store.write({ id, site: sourceName, sourceId, source: url, title: page.title, author: page.author, kind, published: publishedDate.toISOString(), retrieved: now.toISOString(), tags, state: "saved", body: page.body }, Boolean(existing && existing.contentState === "pending"));
  db.prepare("UPDATE items SET content_path = ?, content_state = 'ready', state = 'saved', expires_at = NULL WHERE id = ? AND content_state = 'pending' AND content_origin = 'jomo'").run(path, id);
  if (incoming !== url) db.prepare("INSERT OR REPLACE INTO url_aliases (alias, url) VALUES (?, ?)").run(incoming, url);
  return { id, path, alreadyPresent: false, preview: page.preview };
}

export async function queueUrl(file: string, rawUrl: string): Promise<boolean> {
  let valid: URL;
  try { valid = new URL(normalizeUrl(rawUrl)); } catch { throw new Error("Invalid article URL"); }
  if (valid.protocol !== "http:" && valid.protocol !== "https:") throw new Error("Only HTTP(S) links can be queued");
  const previous = await readFile(file, "utf8");
  const queue = parseQueue(previous);
  if (queue.includes(valid.href)) return false;
  const lines = previous.split("\n");
  const queueStart = lines.findIndex((line) => line.trim() === "## QUEUE");
  const failedStart = lines.findIndex((line, index) => index > queueStart && line.trim() === "## FAILED");
  if (queueStart < 0 || failedStart < 0) throw new Error("LINKS.md needs QUEUE and FAILED sections");
  const updated = [...lines.slice(0, failedStart), `- ${valid.href}`, ...lines.slice(failedStart)].join("\n");
  const mode = (await stat(file)).mode & 0o777;
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, updated, { mode, flag: "wx" });
  try {
    await chmod(temporary, mode);
    if (await readFile(file, "utf8") !== previous) throw new Error("LINKS.md changed; retry the queue action");
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return true;
}

export function parseQueue(text: string): string[] {
  const section = /^## QUEUE\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const url = /^- (https?:\/\/\S+)\s*$/.exec(line)?.[1];
    if (url && !seen.has(url)) { seen.add(url); urls.push(url); }
  }
  return urls;
}

export async function ingestQueue(db: Database.Database, store: Store, queue: string, extract: ExtractLink, limit: number, onProgress?: (progress: IngestProgress) => void, shouldStop?: () => boolean, delayMs: number = BATCH_DELAY_MS, resolve?: (url: string) => Promise<string>) {
  const urls = parseQueue(queue).slice(0, limit);
  const result = { queued: urls.length, ingested: 0, alreadyPresent: 0, failed: [] as Array<{ url: string; reason: string }> };
  const events: IngestEvent[] = [];
  let processed = 0;
  for (const url of urls) {
    if (shouldStop?.()) throw new Error("Ingestion interrupted");
    try {
      const { alreadyPresent, preview } = await ingestArticle(db, store, url, extract, resolve ? { resolve } : {});
      if (alreadyPresent) result.alreadyPresent++;
      else result.ingested++;
      events.push({ url, outcome: alreadyPresent ? "already_present" : "saved", preview: Boolean(preview) });
    } catch (error) {
      if (shouldStop?.()) throw new Error("Ingestion interrupted", { cause: error });
      result.failed.push({ url, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      events.push({ url, outcome: "failed", preview: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
    processed++;
    onProgress?.({ processed, ingested: result.ingested, alreadyPresent: result.alreadyPresent, failed: result.failed, events, current: urls[processed] ?? null });
    if (processed < urls.length && delayMs > 0) await sleep(delayMs);
  }
  return result;
}

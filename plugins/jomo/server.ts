import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createContentStore } from "./content-store";
import { importLibrary } from "./library-import";
import { ingestArticle, ingestQueue, parseQueue, queueUrl, type IngestProgress } from "./queue-ingest";
import { normalizeUrl, resolveUrl } from "./normalize-url";
import { parseFeedXml, syncFeedSources } from "./feed-sync";
import { extractUrl } from "./extract-url";
import { reconcileLinks } from "./reconcile-links";

const answersSchema = z.object({
  interests: z.array(z.string().max(80)).max(20),
  research: z.array(z.string().max(80)).max(20),
  missList: z.array(z.string().max(80)).max(20),
  savedMeaning: z.string().max(120),
  autonomy: z.string().max(120),
}).strict();

const profileSchema = z.object({
  answers: answersSchema,
  acceptedDrafts: z.array(z.string().max(80)).max(20),
  notebook: z.string().max(20_000),
  completedAt: z.number().int().nonnegative(),
}).strict();

export type LibrarianProfile = z.infer<typeof profileSchema>;

export const DEFAULT_CONTENT_ROOT = "/data/obsidian/Agent/Library";

// YouTube channel/handle pages are not feed URLs; resolve the channel's
// stable ID from the page and use the channel_id feed instead.
async function youtubeFeedUrl(url: URL): Promise<URL> {
  if (!/^(?:www\.|m\.)?youtube\.com$/.test(url.hostname)) return url;
  if (!/^\/(?:@|channel\/|c\/|user\/)/.test(url.pathname)) return url;
  const directId = /^\/channel\/(UC[\w-]{20,})/.exec(url.pathname)?.[1];
  if (directId) return new URL(`https://www.youtube.com/feeds/videos.xml?channel_id=${directId}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`YouTube channel page returned HTTP ${response.status}`);
  const html = await response.text();
  const channelId = [
    /<meta[^>]+itemprop=["']identifier["'][^>]+content=["'](UC[\w-]{20,})["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']https?:\/\/www\.youtube\.com\/channel\/(UC[\w-]{20,})["']/i,
    /["']channelId["']\s*:\s*["'](UC[\w-]{20,})["']/i,
    /["']externalId["']\s*:\s*["'](UC[\w-]{20,})["']/i,
    /["']browseId["']\s*:\s*["'](UC[\w-]{20,})["']/i,
  ].map((pattern) => pattern.exec(html)?.[1]).find(Boolean);
  if (!channelId) throw new Error("Could not find the YouTube channel ID on that page");
  return new URL(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
}

async function readFeedResponse(response: Response, limit = 5_000_000): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("Feed response exceeds 5 MB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Feed response exceeds 5 MB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export const rpcContract = defineRpcContract({
  onboarding_get: {
    input: z.object({}).strict(),
    output: z.object({ profile: profileSchema.nullable() }).strict(),
  },
  onboarding_save: {
    input: profileSchema,
    output: z.object({ saved: z.literal(true) }).strict(),
  },
  notebook_save: {
    input: z.object({ notebook: z.string().max(20_000) }).strict(),
    output: z.object({ saved: z.boolean() }).strict(),
  },
  queue_link: {
    input: z.object({ url: z.string().trim().min(1).max(2048).url() }).strict(),
    output: z.object({ added: z.boolean() }).strict(),
  },
  queue_preview: {
    input: z.object({}).strict(),
    output: z.object({ queued: z.number().int().nonnegative() }).strict(),
  },
  queue_start: {
    input: z.object({}).strict(),
    output: z.object({ jobId: z.string(), queued: z.number() }).strict(),
  },
  queue_status: {
    input: z.object({}).strict(),
    output: z.object({ job: z.object({ id: z.string(), type: z.enum(["links", "feeds"]), status: z.enum(["running", "completed", "failed", "interrupted"]), queued: z.number(), processed: z.number(), ingested: z.number(), alreadyPresent: z.number(), failures: z.array(z.object({ url: z.string(), reason: z.string() })), failedCount: z.number(), remaining: z.number().nullable(), error: z.string().nullable(), log: z.array(z.object({ url: z.string(), outcome: z.enum(["saved", "already_present", "failed"]), preview: z.boolean(), reason: z.string().optional() })), currentUrl: z.string().nullable() }).nullable() }).strict(),
  },
  queue_cancel: {
    input: z.object({}).strict(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
  rss_sources_list: {
    input: z.object({}).strict(),
    output: z.object({ sources: z.array(z.object({ id: z.string(), name: z.string(), url: z.string(), kind: z.string(), color: z.string(), enabled: z.boolean(), lastFetchedAt: z.number().nullable() })) }).strict(),
  },
  rss_source_add: {
    input: z.object({ name: z.string().trim().min(1).max(120), url: z.string().trim().min(1).max(2048) }).strict(),
    output: z.object({ id: z.string(), added: z.boolean() }).strict(),
  },
  rss_source_set_enabled: {
    input: z.object({ id: z.string().min(1).max(200), enabled: z.boolean() }).strict(),
    output: z.object({ saved: z.boolean() }).strict(),
  },
  hoard_get: {
    input: z.object({ id: z.string().min(1).max(200) }).strict(),
    output: z.object({ item: z.object({ id: z.string(), sourceId: z.string().nullable(), source: z.string(), sourceColor: z.string(), kind: z.string(), author: z.string().nullable(), title: z.string(), excerpt: z.string(), url: z.string().nullable(), publishedAt: z.number(), tags: z.string(), state: z.enum(["new", "later", "saved"]), contentState: z.string(), expiresAt: z.number().nullable() }).nullable() }).strict(),
  },
  hoard_list: {
    input: z.object({ offset: z.number().int().min(0).max(100_000) }).strict(),
    output: z.object({ items: z.array(z.object({ id: z.string(), sourceId: z.string().nullable(), source: z.string(), sourceColor: z.string(), kind: z.string(), author: z.string().nullable(), title: z.string(), excerpt: z.string(), url: z.string().nullable(), publishedAt: z.number(), tags: z.string(), state: z.enum(["new", "later"]), contentState: z.string(), expiresAt: z.number().nullable() })), total: z.number(), hasMore: z.boolean() }).strict(),
  },
  rss_review_list: {
    input: z.object({ offset: z.number().int().min(0).max(100_000), sourceId: z.string().min(1).max(200).nullable().default(null) }).strict(),
    output: z.object({ items: z.array(z.object({ id: z.string(), sourceId: z.string().nullable(), source: z.string(), kind: z.string(), title: z.string(), author: z.string().nullable(), excerpt: z.string(), url: z.string(), publishedAt: z.number() })), total: z.number(), allTotal: z.number(), hasMore: z.boolean(), sourceCount: z.number(), sources: z.array(z.object({ id: z.string(), name: z.string(), count: z.number().int().nonnegative() })), lastFetchedAt: z.number().nullable(), drainScheduled: z.number(), drainExempt: z.number() }).strict(),
  },
  rss_sync_start: {
    input: z.object({}).strict(),
    output: z.object({ jobId: z.string(), queued: z.number() }).strict(),
  },
  rss_sync_status: {
    input: z.object({}).strict(),
    output: z.object({ job: z.object({ id: z.string(), status: z.enum(["running", "completed", "failed", "interrupted"]), queued: z.number(), processed: z.number(), staged: z.number(), duplicates: z.number(), failures: z.array(z.object({ source: z.string(), reason: z.string() })), failedCount: z.number(), error: z.string().nullable() }).nullable() }).strict(),
  },
  rss_action: {
    input: z.object({ id: z.string().min(1).max(200), action: z.enum(["save", "queue", "discard"]) }).strict(),
    output: z.object({ outcome: z.enum(["saved", "queued", "already_queued", "discarded", "already_present"]) }).strict(),
  },
  rss_discard_ids: {
    input: z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(1000) }).strict(),
    output: z.object({ discarded: z.number() }).strict(),
  },
  library_list: {
    input: z.object({ offset: z.number().int().min(0).max(100_000), state: z.enum(["new", "saved"]).default("saved") }).strict(),
    output: z.object({ items: z.array(z.object({ id: z.string(), source: z.string(), kind: z.string(), title: z.string(), excerpt: z.string(), url: z.string().nullable(), publishedAt: z.number(), contentState: z.string() })), hasMore: z.boolean() }).strict(),
  },
  library_read: {
    input: z.object({ id: z.string().min(1).max(200) }).strict(),
    output: z.object({ body: z.string().nullable(), missing: z.boolean() }).strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  const defaultContentRoot = DEFAULT_CONTENT_ROOT;
  const storageSettings = bb.settings.define({
    contentRoot: { type: "string", label: "Content files directory", default: defaultContentRoot,
      experimental_schema: z.string().refine((root) => {
        try { createContentStore({ contentRoot: root, filenamePattern: "{{date}}-{{slug}}.md" }); return true; } catch { return false; }
      }, "Use an absolute directory or ~/path") },
    filenamePattern: { type: "string", label: "Content filename pattern", default: "{{domain}}/{{date}}-{{slug}}.md",
      experimental_schema: z.string().refine((pattern) => {
        try { createContentStore({ contentRoot: defaultContentRoot, filenamePattern: pattern }); return true; } catch { return false; }
      }, "Use {{domain}}/ and a single .md filename with supported tokens") },
    pruneDrainedFiles: { type: "boolean", label: "Prune drained content files", default: true },
    inboxLinksFile: { type: "string", label: "Links queue file", default: "/data/obsidian/Inbox/LINKS.md",
      experimental_schema: z.string().refine(isAbsolute, "Use an absolute path to LINKS.md") },
  });
  // Append new statements only: the host hashes migration statements by index.
  bb.storage.migrate(db, [
    `CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL, color TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, paused_note TEXT, last_fetch_at INTEGER, created_at INTEGER NOT NULL)`, // Historical migration index; unused pause-note column removed below.
    `CREATE TABLE rounds (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, completed_at INTEGER, receipt_json TEXT)`,
    `CREATE TABLE items (id TEXT PRIMARY KEY, round_id TEXT REFERENCES rounds(id), source_id TEXT REFERENCES sources(id), display_source TEXT NOT NULL, kind TEXT NOT NULL, author TEXT, title TEXT, excerpt TEXT, url TEXT, published_at INTEGER NOT NULL, tags TEXT NOT NULL DEFAULT '[]', kind_extras TEXT, state TEXT NOT NULL DEFAULT 'new', state_changed_at INTEGER, state_changed_by TEXT, expires_at INTEGER, drained_at INTEGER, content_path TEXT, content_state TEXT NOT NULL DEFAULT 'pending', deleted_file_at INTEGER)`,
    `CREATE INDEX idx_items_round_state_pub ON items(round_id, published_at DESC)`,
    `CREATE INDEX idx_items_state_kind_pub ON items(state, kind, published_at DESC)`,
    `CREATE INDEX idx_items_reservoir ON items(published_at) WHERE state IN ('new','later')`,
    `CREATE INDEX idx_items_source_pub ON items(source_id, published_at DESC)`,
    `CREATE INDEX idx_items_source_round ON items(source_id, round_id)`,
    `CREATE TABLE item_notes (item_id TEXT PRIMARY KEY, note TEXT NOT NULL, updated_at INTEGER NOT NULL)`, // Historical migration index; removed by the final statement below.
    `CREATE TABLE seen_entries (source_id TEXT NOT NULL, guid TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (source_id, guid))`,
    `ALTER TABLE items ADD COLUMN content_origin TEXT NOT NULL DEFAULT 'jomo'`, // Imported vault files are read-only references, not JOMO-owned outputs.
    `CREATE TABLE queue_jobs (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, status TEXT NOT NULL, queued INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, ingested INTEGER NOT NULL DEFAULT 0, already_present INTEGER NOT NULL DEFAULT 0, failures_json TEXT NOT NULL DEFAULT '[]', failed_count INTEGER NOT NULL DEFAULT 0, remaining INTEGER, error TEXT)`,
    `ALTER TABLE queue_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'links'`,
    `ALTER TABLE queue_jobs ADD COLUMN receipt_json TEXT`,
    `CREATE TABLE rss_sync_jobs (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, status TEXT NOT NULL, queued INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, staged INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, failures_json TEXT NOT NULL DEFAULT '[]', failed_count INTEGER NOT NULL DEFAULT 0, error TEXT)`,
    `CREATE INDEX idx_items_rss_review ON items(published_at DESC) WHERE state = 'new' AND content_state = 'staged'`,
    `ALTER TABLE queue_jobs ADD COLUMN log_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE queue_jobs ADD COLUMN current_url TEXT`,
    `CREATE TABLE url_aliases (alias TEXT PRIMARY KEY, url TEXT NOT NULL)`, // Queue links that redirected: original URL to the archived canonical URL.
    `DROP TABLE IF EXISTS item_notes`,
    `ALTER TABLE sources DROP COLUMN paused_note`,
  ]);
  db.prepare("UPDATE queue_jobs SET status = 'interrupted', error = 'JOMO reloaded before this run completed' WHERE status = 'running'").run();
  db.prepare("UPDATE rss_sync_jobs SET status = 'interrupted', error = 'JOMO reloaded before this run completed' WHERE status = 'running'").run();

  const drainExpired = () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE items SET state = 'dropped', drained_at = ?, state_changed_at = ?, state_changed_by = 'rule', expires_at = NULL WHERE state = 'new' AND content_state = 'staged' AND expires_at IS NOT NULL AND expires_at <= ?").run(now, now, now);
  };
  drainExpired();
  const drainTimer = setInterval(drainExpired, 60 * 60 * 1000);
  let ingestionRunning = false;
  let rssSyncRunning = false;
  const controllers = new Set<AbortController>();
  const queueControllers = new Map<string, AbortController>();
  bb.onDispose(() => {
    clearInterval(drainTimer);
    for (const controller of controllers) controller.abort();
    db.prepare("UPDATE queue_jobs SET status = 'interrupted', error = 'JOMO unloaded during this run' WHERE status = 'running'").run();
    db.prepare("UPDATE rss_sync_jobs SET status = 'interrupted', error = 'JOMO unloaded during this run' WHERE status = 'running'").run();
  });
  async function runIngestion(limit: number, jobId?: string, onProgress?: (progress: IngestProgress) => void) {
    if (ingestionRunning) throw new Error("A JOMO ingestion is already running");
    ingestionRunning = true;
    const controller = new AbortController();
    controllers.add(controller);
    if (jobId) queueControllers.set(jobId, controller);
    try {
      const settings = await storageSettings.get();
      const queue = await readFile(settings.inboxLinksFile, "utf8");
      const store = createContentStore(settings);
      const result = await ingestQueue(db, store, queue, (url) => extractUrl(url, fetch, controller.signal), limit, onProgress, () => controller.signal.aborted, Number(process.env.JOMO_BATCH_DELAY_MS ?? 3_000), (url) => resolveUrl(url, fetch, controller.signal));
      const reconciliation = await reconcileLinks(db, settings.inboxLinksFile, settings.contentRoot, new Date().toISOString().slice(0, 10), Object.fromEntries(result.failed.map(({ url, reason }) => [url, reason])));
      return { ...result, reconciliation };
    } finally { controllers.delete(controller); if (jobId) queueControllers.delete(jobId); ingestionRunning = false; }
  }

  async function runRssSync(jobId: string, controller: AbortController) {
    controllers.add(controller);
    try {
      const result = await syncFeedSources(db, async (url, signal) => {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only HTTP(S) feed URLs are allowed");
        const response = await fetch(parsed.href, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1" } });
        if (!response.ok) throw new Error(`Feed responded with HTTP ${response.status}`);
        return await readFeedResponse(response);
      }, ({ processed, staged, duplicates, failures }) => {
        db.prepare("UPDATE rss_sync_jobs SET processed = ?, staged = ?, duplicates = ?, failures_json = ?, failed_count = ? WHERE id = ?")
          .run(processed, staged, duplicates, JSON.stringify(failures.slice(-20)), failures.length, jobId);
      }, () => controller.signal.aborted, controller.signal);
      db.prepare("UPDATE rss_sync_jobs SET status = 'completed', processed = ?, staged = ?, duplicates = ?, failures_json = ?, failed_count = ? WHERE id = ? AND status = 'running'")
        .run(result.processed, result.staged, result.duplicates, JSON.stringify(result.failures.slice(-20)), result.failures.length, jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.error(`JOMO RSS sync failed: ${message}`);
      try { db.prepare("UPDATE rss_sync_jobs SET status = ?, error = ? WHERE id = ? AND status = 'running'").run(controller.signal.aborted ? "interrupted" : "failed", message.slice(0, 500), jobId); } catch { /* plugin may already be disposed */ }
    } finally {
      controllers.delete(controller);
      rssSyncRunning = false;
    }
  }

  bb.cli.register({
    name: "jomo", summary: "JOMO library maintenance",
    commands: [
      { name: "import-library", summary: "Import existing vault articles into JOMO", usage: "bb jomo import-library --dry-run|--apply" },
      { name: "ingest-links", summary: "Ingest links from the Obsidian QUEUE without editing it", usage: "bb jomo ingest-links --dry-run|--limit N" },
      { name: "reconcile-links", summary: "Reconcile saved links and daily index without fetching", usage: "bb jomo reconcile-links --dry-run|--apply" }
    ],
    async run(argv) {
      const settings = await storageSettings.get();
      if (argv[0] === "import-library" && argv.length === 2 && ["--dry-run", "--apply"].includes(argv[1])) {
        const result = await importLibrary(db, settings.contentRoot, argv[1] === "--apply");
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
      }
      if (argv[0] === "reconcile-links" && argv.length === 2 && ["--dry-run", "--apply"].includes(argv[1])) {
        if (argv[1] === "--dry-run") {
          const queue = parseQueue(await readFile(settings.inboxLinksFile, "utf8"));
          const hasSaved = db.prepare("SELECT 1 FROM items WHERE url = ? AND state = 'saved' AND content_state = 'ready' AND content_path IS NOT NULL LIMIT 1");
          return { exitCode: 0, stdout: JSON.stringify({ archivedInQueue: queue.filter((url) => hasSaved.get(normalizeUrl(url), normalizeUrl(url))).length, queued: queue.length }) };
        }
        const result = await reconcileLinks(db, settings.inboxLinksFile, settings.contentRoot, new Date().toISOString().slice(0, 10));
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
      }
      if (argv[0] === "ingest-links" && (argv.length === 2 && argv[1] === "--dry-run" || argv.length === 3 && argv[1] === "--limit" && /^[1-9]\d?$/.test(argv[2]))) {
        const queue = await readFile(settings.inboxLinksFile, "utf8");
        if (argv[1] === "--dry-run") return { exitCode: 0, stdout: JSON.stringify({ queued: parseQueue(queue).length, mode: "dry-run", inboxUnchanged: true }) };
        const result = await runIngestion(Number(argv[2]));
        return { exitCode: result.failed.length ? 1 : 0, stdout: JSON.stringify(result, null, 2) };
      }
      return { exitCode: 2, stderr: "Usage: bb jomo import-library --dry-run|--apply | bb jomo ingest-links --dry-run|--limit N (1..99) | bb jomo reconcile-links --dry-run|--apply" };
    },
  });

  bb.rpc.register(rpcContract, {
    async onboarding_get() {
      const profile = await bb.storage.kv.get<LibrarianProfile>("librarian-profile");
      return { profile: profile ?? null };
    },
    async onboarding_save(profile) {
      await bb.storage.kv.set("librarian-profile", profile);
      return { saved: true as const };
    },
    async notebook_save({ notebook }) {
      const profile = await bb.storage.kv.get<LibrarianProfile>("librarian-profile");
      if (!profile) return { saved: false };
      await bb.storage.kv.set("librarian-profile", { ...profile, notebook });
      return { saved: true };
    },
    async queue_link({ url }) {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Only HTTP(S) links without credentials may be queued");
      const { inboxLinksFile } = await storageSettings.get();
      return { added: await queueUrl(inboxLinksFile, parsed.href) };
    },
    async queue_preview() {
      const { inboxLinksFile } = await storageSettings.get();
      return { queued: parseQueue(await readFile(inboxLinksFile, "utf8")).length };
    },
    async queue_start() {
      if (ingestionRunning) {
        const active = db.prepare("SELECT id, queued FROM queue_jobs WHERE status = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as { id: string; queued: number } | undefined;
        if (active) return { jobId: active.id, queued: active.queued };
        throw new Error("Another JOMO ingestion is running");
      }
      const { inboxLinksFile } = await storageSettings.get();
      const queued = parseQueue(await readFile(inboxLinksFile, "utf8")).length;
      const jobId = randomUUID();
      db.prepare("INSERT INTO queue_jobs (id, started_at, status, queued, job_type) VALUES (?, ?, 'running', ?, 'links')").run(jobId, Date.now(), queued);
      void runIngestion(Number.MAX_SAFE_INTEGER, jobId, (progress: IngestProgress) => {
        db.prepare("UPDATE queue_jobs SET processed = ?, ingested = ?, already_present = ?, failures_json = ?, failed_count = ?, log_json = ?, current_url = ? WHERE id = ?")
          .run(progress.processed, progress.ingested, progress.alreadyPresent, JSON.stringify(progress.failed.slice(-20)), progress.failed.length, JSON.stringify(progress.events.slice(-20)), progress.current, jobId);
      }).then(({ reconciliation }) => {
        db.prepare("UPDATE queue_jobs SET status = 'completed', remaining = ?, current_url = NULL WHERE id = ?").run(reconciliation.remaining, jobId);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        bb.log.error(`JOMO queue job failed: ${message}`);
        try { db.prepare("UPDATE queue_jobs SET status = ?, error = ?, current_url = NULL WHERE id = ? AND status = 'running'").run(message.startsWith("Ingestion interrupted") ? "interrupted" : "failed", message.slice(0, 500), jobId); } catch { /* plugin may already be disposed */ }
      });
      return { jobId, queued };
    },
    async queue_status() {
      // The pre-SQLite links pipeline recorded its last all-89-feeds failure
      // sweep at 2026-09-24T01:44Z; the SQLite-backed queue shipped hours
      // later (first real run ~11:12Z). Legacy rows must not surface as a
      // phantom "last run" in Bring in links.
      const queueHistoryCutoff = Date.parse("2026-09-24T12:00:00Z");
      const row = db.prepare("SELECT id, job_type AS type, status, queued, processed, ingested, already_present AS alreadyPresent, failures_json AS failuresJson, failed_count AS failedCount, remaining, error, log_json AS logJson, current_url AS currentUrl FROM queue_jobs WHERE started_at >= ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(queueHistoryCutoff) as { id: string; type: "links" | "feeds"; status: "running" | "completed" | "failed" | "interrupted"; queued: number; processed: number; ingested: number; alreadyPresent: number; failuresJson: string; failedCount: number; remaining: number | null; error: string | null; logJson: string; currentUrl: string | null } | undefined;
      return { job: row ? { id: row.id, type: row.type, status: row.status, queued: row.queued, processed: row.processed, ingested: row.ingested, alreadyPresent: row.alreadyPresent, failures: JSON.parse(row.failuresJson) as Array<{ url: string; reason: string }>, failedCount: row.failedCount, remaining: row.remaining, error: row.error, log: JSON.parse(row.logJson) as Array<{ url: string; outcome: "saved" | "already_present" | "failed"; preview: boolean; reason?: string }>, currentUrl: row.currentUrl } : null };
    },
    async queue_cancel() {
      const active = db.prepare("SELECT id FROM queue_jobs WHERE status = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined;
      if (!active) return { cancelled: false };
      const controller = queueControllers.get(active.id);
      if (!controller) return { cancelled: false };
      controller.abort();
      return { cancelled: true };
    },
    async rss_sources_list() {
      const sources = db.prepare("SELECT id, name, url, kind, color, enabled, last_fetch_at AS lastFetchedAt FROM sources ORDER BY enabled DESC, name COLLATE NOCASE, id").all() as Array<{ id: string; name: string; url: string; kind: string; color: string; enabled: number; lastFetchedAt: number | null }>;
      return { sources: sources.map((source) => ({ ...source, enabled: source.enabled === 1 })) };
    },
    async rss_source_add({ name, url }) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error("Enter a valid feed URL"); }
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) throw new Error("Feed URLs must use HTTP(S) and cannot contain credentials");
      // Adding a source is an explicit fetch: resolve YouTube channels to
      // their channel_id feed and verify the feed parses before persisting,
      // so a typo never lands silently in the drawer.
      let canonical: URL;
      try { canonical = await youtubeFeedUrl(parsed); } catch (cause) { throw cause instanceof Error ? cause : new Error("Could not resolve that YouTube channel"); }
      let xml: string;
      try {
        const response = await fetch(canonical, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1" } });
        if (!response.ok) throw new Error(`Feed responded with HTTP ${response.status}`);
        xml = await readFeedResponse(response);
        parseFeedXml(xml);
      } catch (cause) {
        throw new Error(`That URL is not a usable feed (${cause instanceof Error ? cause.message : String(cause)})`);
      }
      const existing = db.prepare("SELECT id FROM sources WHERE url = ? LIMIT 1").get(canonical.href) as { id: string } | undefined;
      if (existing) return { id: existing.id, added: false };
      const id = `src_${createHash("sha256").update(canonical.href).digest("hex").slice(0, 24)}`;
      const hostname = canonical.hostname.toLowerCase();
      const kind = hostname.includes("github.com") ? "github" : hostname.includes("youtube.com") ? "youtube" : hostname.includes("mastodon") || hostname.includes("fosstodon") ? "mastodon" : "rss";
      db.prepare("INSERT INTO sources (id, name, url, kind, color, enabled, created_at) VALUES (?, ?, ?, ?, '#64748b', 0, ?)").run(id, name, canonical.href, kind, Math.floor(Date.now() / 1000));
      return { id, added: true };
    },
    async rss_source_set_enabled({ id, enabled }) {
      const result = db.prepare("UPDATE sources SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
      return { saved: result.changes === 1 };
    },
    async hoard_get({ id }) {
      const item = db.prepare("SELECT i.id, i.source_id AS sourceId, i.display_source AS source, COALESCE(s.color, '#64748b') AS sourceColor, i.kind, i.author, COALESCE(i.title, '') AS title, COALESCE(i.excerpt, '') AS excerpt, i.url, i.published_at AS publishedAt, i.tags, i.state, i.content_state AS contentState, i.expires_at AS expiresAt FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND i.state IN ('new','later','saved') AND i.content_state IN ('staged','pending','ready','missing')").get(id) as { id: string; sourceId: string | null; source: string; sourceColor: string; kind: string; author: string | null; title: string; excerpt: string; url: string | null; publishedAt: number; tags: string; state: "new" | "later" | "saved"; contentState: string; expiresAt: number | null } | undefined;
      return { item: item ?? null };
    },
    async hoard_list({ offset }) {
      drainExpired();
      const total = (db.prepare("SELECT COUNT(*) AS count FROM items WHERE state IN ('new','later') AND content_state IN ('staged','pending','ready')").get() as { count: number }).count;
      const rows = db.prepare("SELECT i.id, i.source_id AS sourceId, i.display_source AS source, COALESCE(s.color, '#64748b') AS sourceColor, i.kind, i.author, COALESCE(i.title, '') AS title, COALESCE(i.excerpt, '') AS excerpt, i.url, i.published_at AS publishedAt, i.tags, i.state, i.content_state AS contentState, i.expires_at AS expiresAt FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.state IN ('new','later') AND i.content_state IN ('staged','pending','ready') ORDER BY i.published_at DESC, i.id LIMIT 26 OFFSET ?").all(offset) as Array<{ id: string; sourceId: string | null; source: string; sourceColor: string; kind: string; author: string | null; title: string; excerpt: string; url: string | null; publishedAt: number; tags: string; state: "new" | "later"; contentState: string; expiresAt: number | null }>;
      return { items: rows.slice(0, 25), total, hasMore: rows.length > 25 };
    },
    async rss_review_list({ offset, sourceId }) {
      drainExpired();
      const reviewWhere = "state = 'new' AND content_state IN ('staged','pending') AND url IS NOT NULL";
      const allTotal = (db.prepare(`SELECT COUNT(*) AS count FROM items WHERE ${reviewWhere}`).get() as { count: number }).count;
      const filterSql = sourceId ? " AND source_id = ?" : "";
      const params = sourceId ? [sourceId] : [];
      const total = (db.prepare(`SELECT COUNT(*) AS count FROM items WHERE ${reviewWhere}${filterSql}`).get(...params) as { count: number }).count;
      const sourceRows = db.prepare(`SELECT source_id AS id, MAX(display_source) AS name, COUNT(*) AS count FROM items WHERE ${reviewWhere} GROUP BY source_id ORDER BY count DESC, name COLLATE NOCASE, id`).all() as Array<{ id: string | null; name: string; count: number }>;
      const sources = sourceRows.filter((source): source is { id: string; name: string; count: number } => source.id !== null);
      const drainScheduled = (db.prepare("SELECT COUNT(*) AS count FROM items WHERE state IN ('new','later') AND content_state IN ('staged','pending','ready') AND expires_at IS NOT NULL").get() as { count: number }).count;
      const drainExempt = (db.prepare("SELECT COUNT(*) AS count FROM items WHERE state IN ('new','later') AND content_state IN ('staged','pending','ready') AND expires_at IS NULL").get() as { count: number }).count;
      const rows = db.prepare(`SELECT id, source_id AS sourceId, display_source AS source, kind, COALESCE(title, '') AS title, author, COALESCE(excerpt, '') AS excerpt, url, published_at AS publishedAt FROM items WHERE ${reviewWhere}${filterSql} ORDER BY published_at DESC, id LIMIT 26 OFFSET ?`).all(...params, offset) as Array<{ id: string; sourceId: string | null; source: string; kind: string; title: string; author: string | null; excerpt: string; url: string; publishedAt: number }>;
      const sourceCount = (db.prepare("SELECT COUNT(*) AS count FROM sources WHERE enabled = 1").get() as { count: number }).count;
      const lastFetchedAt = (db.prepare("SELECT MAX(last_fetch_at) AS fetched FROM sources WHERE enabled = 1").get() as { fetched: number | null }).fetched;
      return { items: rows.slice(0, 25), total, allTotal, hasMore: rows.length > 25, sourceCount, sources, lastFetchedAt, drainScheduled, drainExempt };
    },
    async rss_sync_start() {
      if (rssSyncRunning) {
        const active = db.prepare("SELECT id, queued FROM rss_sync_jobs WHERE status = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as { id: string; queued: number } | undefined;
        if (active) return { jobId: active.id, queued: active.queued };
        throw new Error("Another JOMO RSS sync is running");
      }
      const queued = (db.prepare("SELECT COUNT(*) AS count FROM sources WHERE enabled = 1").get() as { count: number }).count;
      const jobId = randomUUID();
      const controller = new AbortController();
      rssSyncRunning = true;
      db.prepare("INSERT INTO rss_sync_jobs (id, started_at, status, queued) VALUES (?, ?, 'running', ?)").run(jobId, Date.now(), queued);
      void runRssSync(jobId, controller);
      return { jobId, queued };
    },
    async rss_sync_status() {
      const row = db.prepare("SELECT id, status, queued, processed, staged, duplicates, failures_json AS failuresJson, failed_count AS failedCount, error FROM rss_sync_jobs ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as { id: string; status: "running" | "completed" | "failed" | "interrupted"; queued: number; processed: number; staged: number; duplicates: number; failuresJson: string; failedCount: number; error: string | null } | undefined;
      return { job: row ? { id: row.id, status: row.status, queued: row.queued, processed: row.processed, staged: row.staged, duplicates: row.duplicates, failures: JSON.parse(row.failuresJson) as Array<{ source: string; reason: string }>, failedCount: row.failedCount, error: row.error } : null };
    },
    async rss_action({ id, action }) {
      const item = db.prepare("SELECT source_id AS sourceId, display_source AS source, title, url, tags, state, content_state AS contentState, content_path AS contentPath, content_origin AS origin FROM items WHERE id = ? AND state IN ('new','later') AND content_state IN ('staged','pending','ready')").get(id) as { sourceId: string | null; source: string; title: string | null; url: string | null; tags: string; state: string; contentState: string; contentPath: string | null; origin: string } | undefined;
      if (!item?.url) throw new Error("This item is no longer waiting for review");
      if (item.contentState === "ready") {
        if (item.origin !== "jomo" || !item.contentPath || action !== "save") throw new Error("This item cannot be changed here");
        const settings = await storageSettings.get();
        await createContentStore(settings).mirrorState(item.contentPath, id, "saved");
        db.prepare("UPDATE items SET state = 'saved', expires_at = NULL, state_changed_at = ?, state_changed_by = 'user' WHERE id = ? AND state IN ('new','later')").run(Math.floor(Date.now() / 1000), id);
        return { outcome: "saved" as const };
      }
      if (ingestionRunning) throw new Error("Another JOMO article ingestion is running");
      if (item.state === "later" && action === "discard") throw new Error("Queued links must be removed from LINKS.md before discarding");
      if (item.state === "later" && action === "queue") return { outcome: "already_queued" as const };
      if (action === "discard") {
        db.prepare("UPDATE items SET state = 'dropped', state_changed_at = ?, state_changed_by = 'user' WHERE id = ? AND state = 'new' AND content_state IN ('staged','pending')").run(Math.floor(Date.now() / 1000), id);
        return { outcome: "discarded" as const };
      }
      if (action === "queue") {
        const { inboxLinksFile } = await storageSettings.get();
        const added = await queueUrl(inboxLinksFile, item.url);
        db.prepare("UPDATE items SET state = 'later', expires_at = NULL, state_changed_at = ?, state_changed_by = 'user' WHERE id = ? AND state = 'new' AND content_state IN ('staged','pending')").run(Math.floor(Date.now() / 1000), id);
        return { outcome: added ? "queued" as const : "already_queued" as const };
      }
      ingestionRunning = true;
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const settings = await storageSettings.get();
        const tags = JSON.parse(item.tags) as string[];
        const result = await ingestArticle(db, createContentStore(settings), item.url, (url) => extractUrl(url, fetch, controller.signal), { id, sourceId: item.sourceId, sourceName: item.source, tags });
        if (result.alreadyPresent) return { outcome: "already_present" as const };
        try {
          await reconcileLinks(db, settings.inboxLinksFile, settings.contentRoot, new Date().toISOString().slice(0, 10));
        } catch (error) {
          bb.log.error(`JOMO saved RSS item ${id}, but Library index reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { outcome: "saved" as const };
      } finally {
        controllers.delete(controller);
        ingestionRunning = false;
      }
    },
    async rss_discard_ids({ ids }) {
      // Salvage leftovers: only staged, unfetched items may be batch-dropped,
      // and only by explicit id so the batch matches what the reviewer saw.
      const now = Math.floor(Date.now() / 1000);
      const discard = db.prepare("UPDATE items SET state = 'dropped', state_changed_at = ?, state_changed_by = 'user' WHERE id = ? AND state = 'new' AND content_state IN ('staged','pending')");
      let discarded = 0;
      db.transaction(() => { for (const id of ids) discarded += discard.run(now, id).changes; })();
      return { discarded };
    },
    async library_list({ offset, state }) {
      const rows = db.prepare("SELECT id, display_source AS source, kind, COALESCE(title, '') AS title, COALESCE(excerpt, '') AS excerpt, url, published_at AS publishedAt, content_state AS contentState FROM items WHERE state = ? ORDER BY published_at DESC, id LIMIT 51 OFFSET ?").all(state, offset) as Array<{ id: string; source: string; kind: string; title: string; excerpt: string; url: string | null; publishedAt: number; contentState: string }>;
      return { items: rows.slice(0, 50), hasMore: rows.length > 50 };
    },
    async library_read({ id }) {
      const item = db.prepare("SELECT content_path AS path, content_state AS state FROM items WHERE id = ? AND state IN ('new', 'saved', 'later')").get(id) as { path: string | null; state: string } | undefined;
      if (!item?.path || item.state !== "ready") return { body: null, missing: true };
      const { contentRoot, filenamePattern } = await storageSettings.get();
      try {
        return { body: await createContentStore({ contentRoot: contentRoot ?? DEFAULT_CONTENT_ROOT, filenamePattern: filenamePattern ?? "{{domain}}/{{date}}-{{slug}}.md" }).readBody(item.path), missing: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        db.prepare("UPDATE items SET content_state = 'missing' WHERE id = ?").run(id);
        return { body: null, missing: true };
      }
    },
  });

  bb.log.info("JOMO loaded with SQLite hoard, explicit RSS review, and librarian interview");
}

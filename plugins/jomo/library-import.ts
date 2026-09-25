import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type Database from "better-sqlite3";
import YAML from "yaml";

type ImportRow = {
  id: string; path: string; title: string; url: string; source: string; excerpt: string;
  published: number; tagsJson: string; kind: string; author: string | null;
};

async function* markdownFiles(root: string, directory = root): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* markdownFiles(root, path);
    else if (entry.isFile() && entry.name.endsWith(".md")) yield path;
  }
}

export async function importLibrary(db: Database.Database, root: string, apply: boolean) {
  const rows: ImportRow[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for await (const file of markdownFiles(root)) {
    const path = relative(root, file).split(sep).join("/");
    try {
      const raw = await readFile(file, "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/.exec(raw);
      if (!match) throw new Error("no frontmatter");
      const metadata: unknown = YAML.parse(match[1]);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("invalid frontmatter");
      const fields = metadata as Record<string, unknown>;
      const url = String(fields.source || fields.resolved_url || "");
      if (!/^https?:\/\//i.test(url)) throw new Error("no source URL");
      const title = String(fields.title || "").trim();
      if (!title) throw new Error("no title");
      const body = raw.slice(match[0].length);
      const date = Date.parse(String(fields.published || fields.retrieved || ""));
      const published = Math.floor((Number.isFinite(date) ? date : (await stat(file)).mtimeMs) / 1000);
      const source = String(fields.site || fields.domain || new URL(url).hostname);
      const tagsJson = JSON.stringify(Array.isArray(fields.tags) ? fields.tags.map(String).slice(0, 30) : []);
      const excerpt = String(fields.description || body.replace(/[#*_`>\[\]]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 500);
      const host = new URL(url).hostname;
      const kind = /(?:youtube\.com|youtu\.be)/.test(host) ? "video" : host === "github.com" ? "repo" : /(?:x\.com|twitter\.com)/.test(host) ? "post" : "article";
      rows.push({ id: `itm_${createHash("sha256").update(path).digest("hex").slice(0, 24)}`, path, title, url, source, excerpt, published, tagsJson, kind, author: fields.author ? String(fields.author) : null });
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  let imported = 0;
  if (apply) {
    const insert = db.prepare(`INSERT OR IGNORE INTO items (id, display_source, kind, author, title, excerpt, url, published_at, tags, state, content_path, content_state, content_origin)
      VALUES (@id, @source, @kind, @author, @title, @excerpt, @url, @published, @tagsJson, 'saved', @path, 'ready', 'imported')`);
    imported = db.transaction(() => {
      let count = 0;
      for (const row of rows) count += insert.run(row).changes;
      return count;
    })();
  }
  return { scanned: rows.length + skipped.length, ready: rows.length, skipped: skipped.length, skipExamples: skipped.slice(0, 20), imported, alreadyPresent: apply ? rows.length - imported : 0, mode: apply ? "apply" : "dry-run" };
}

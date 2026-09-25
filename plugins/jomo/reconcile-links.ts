import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { normalizeUrl } from "./normalize-url";

export type ReconcileReceipt = { archived: number; failed: number; remaining: number; indexed: number };

async function writeIfUnchanged(path: string, previous: string | null, next: string): Promise<void> {
  if (previous === next) return;
  const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current !== previous) throw new Error(`${path} changed during reconciliation; retry without overwriting the other edit`);
  const mode = previous === null ? 0o644 : (await stat(path)).mode & 0o777;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, next, { mode, flag: "wx" });
  try {
    await chmod(temporary, mode);
    // Check again immediately before replacing. Another writer after this check
    // remains a filesystem race; BB runs this reconciliation in one CLI call.
    const latest = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (latest !== previous) throw new Error(`${path} changed during reconciliation`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function reconcileLinks(db: Database.Database, linksFile: string, contentRoot: string, date: string, failures: Record<string, string> = {}): Promise<ReconcileReceipt> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid index date");
  const source = await readFile(linksFile, "utf8");
  const lines = source.split("\n");
  const queueStart = lines.findIndex((line) => line.trim() === "## QUEUE");
  const failedStart = lines.findIndex((line, i) => i > queueStart && line.trim() === "## FAILED");
  if (queueStart < 0 || failedStart < 0) throw new Error("LINKS.md needs QUEUE and FAILED sections");
  // Match the queue line's URL directly or through the alias table, so a
  // redirected link still retires its original LINKS.md entry.
  const archivedRow = db.prepare("SELECT content_path AS path FROM items WHERE (url = ? OR url = (SELECT url FROM url_aliases WHERE alias = ?)) AND state = 'saved' AND content_state = 'ready' LIMIT 1");
  const kept: string[] = [];
  const movedFailures: Array<{ url: string; reason: string }> = [];
  let archived = 0;
  for (const line of lines.slice(queueStart + 1, failedStart)) {
    const url = /^- (https?:\/\/\S+)\s*$/.exec(line)?.[1];
    const canonical = url ? normalizeUrl(url) : null;
    if (canonical && (archivedRow.get(canonical, canonical) as { path: string | null } | undefined)?.path) { archived++; continue; }
    if (url && (failures[url] ?? failures[normalizeUrl(url)])) { const reason = failures[url] ?? failures[normalizeUrl(url)]; movedFailures.push({ url, reason: reason.replace(/\s+/g, " ").slice(0, 200) }); continue; }
    kept.push(line);
  }

  const root = resolve(contentRoot);
  const owned = db.prepare("SELECT id, title, display_source AS site, kind, content_path AS path FROM items WHERE content_origin = 'jomo' AND state = 'saved' AND content_state = 'ready' AND content_path IS NOT NULL").all() as Array<{ id: string; title: string; site: string; kind: string; path: string }>;
  const entries: Array<{ title: string; path: string; group: string }> = [];
  for (const item of owned) {
    if (isAbsolute(item.path) || item.path.split(/[\\/]/).includes("..")) continue;
    const file = resolve(root, item.path);
    if (!relative(root, file) || relative(root, file).startsWith(`..${sep}`)) continue;
    let content: string;
    try { content = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!content.startsWith(`---\nid: ${JSON.stringify(item.id)}\n`) || !new RegExp(`^retrieved: "${date.replace(/-/g, "\\-")}`, "m").test(content)) continue;
    const group = item.kind === "video" ? "YouTube" : item.kind === "post" ? "X" : item.kind === "repo" ? "GitHub" : "Web";
    entries.push({ title: `${item.title}${item.site ? ` — ${item.site}` : ""}`, path: item.path.split(sep).join("/"), group });
  }
  const indexPath = join(root, "_index", `${date}.md`);
  await mkdir(dirname(indexPath), { recursive: true });
  const existingIndex = await readFile(indexPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const additions = entries.filter((entry) => !existingIndex?.includes(`](../${entry.path})`));
  additions.sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
  if (additions.length) {
    const sections: string[] = [];
    for (const group of [...new Set(additions.map((entry) => entry.group))]) {
      sections.push(`## ${group}`, "", ...additions.filter((entry) => entry.group === group).map((entry) => `- [${entry.title.replace(/\]/g, "\\]")}](../${entry.path})`), "");
    }
    const nextIndex = existingIndex === null ? `# Archive — ${date}\n\n${sections.join("\n")}` : `${existingIndex.trimEnd()}\n\n${sections.join("\n")}`;
    await writeIfUnchanged(indexPath, existingIndex, nextIndex);
  }

  const failedEnd = lines.findIndex((line, i) => i > failedStart && line.startsWith("## "));
  const end = failedEnd < 0 ? lines.length : failedEnd;
  const failedLines = lines.slice(failedStart + 1, end);
  const known = new Set(failedLines.map((line) => /^- (https?:\/\/\S+)/.exec(line)?.[1]).filter(Boolean));
  for (const { url, reason } of movedFailures) {
    if (!known.has(url)) { failedLines.push(`- ${url} — ${reason}`); known.add(url); }
  }
  const updated = [...lines.slice(0, queueStart + 1), ...kept, "## FAILED", ...failedLines, ...lines.slice(end)].join("\n");
  await writeIfUnchanged(linksFile, source, updated);
  return { archived, failed: movedFailures.length, remaining: kept.filter((line) => /^- https?:\/\//.test(line)).length, indexed: additions.length };
}

import { open, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ContentItem = {
  id: string;
  site: string;
  sourceId: string | null;
  source: string;
  title: string;
  author?: string;
  kind: string;
  published: string;
  retrieved: string;
  tags: string[];
  state: string;
  body: string;
};

export type ContentSettings = { contentRoot: string; filenamePattern: string };

const TOKENS = new Set(["domain", "date", "site", "slug", "idSuffix"]);

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "untitled";
}

function rootPath(raw: string): string {
  if (!raw || (!isAbsolute(raw) && raw !== "~" && !raw.startsWith(`~${sep}`))) throw new Error("Content root must be absolute or start with ~/.");
  return resolve(raw === "~" ? homedir() : raw.startsWith(`~${sep}`) ? join(homedir(), raw.slice(2)) : raw);
}

function safePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some((segment) => segment === ".." || segment === "." || !segment)) throw new Error("Invalid content path");
  const resolved = resolve(root, path);
  if (!relative(root, resolved) || relative(root, resolved).startsWith(`..${sep}`)) throw new Error("Content path escapes root");
  return resolved;
}

async function rejectSymlinks(root: string, file: string): Promise<void> {
  const parts = relative(root, file).split(sep);
  let current = root;
  let ancestor = root;
  while (true) {
    const stat = await lstat(ancestor);
    if (stat.isSymbolicLink()) throw new Error("Content root contains a symlink");
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!(await lstat(root)).isDirectory()) throw new Error("Unsafe content root");
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Content path contains a symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function createContentStore(settings: ContentSettings) {
  const root = rootPath(settings.contentRoot);
  const filename = settings.filenamePattern.startsWith("{{domain}}/") ? settings.filenamePattern.slice("{{domain}}/".length) : settings.filenamePattern;
  if (!filename.endsWith(".md") || /[\\/]/.test(filename) || filename.includes("{{domain}}")) throw new Error("Filename pattern must be {{domain}}/ followed by a single .md filename");
  const tokens = [...settings.filenamePattern.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]);
  if (tokens.some((token) => !TOKENS.has(token)) || /\{\{|\}\}/.test(settings.filenamePattern.replace(/\{\{[^{}]+\}\}/g, ""))) {
    throw new Error("Invalid filename pattern");
  }

  return {
    async write(item: ContentItem, recoverPending = false): Promise<string> {
      if (!/^itm_[a-zA-Z0-9_-]{6,}$/.test(item.id)) throw new Error("Invalid item ID");
      const values: Record<string, string> = {
        date: slug(item.published.slice(0, 10)), site: slug(item.site), slug: slug(item.title), idSuffix: item.id.slice(-6),
      };
      const url = new URL(item.source);
      const domain = url.hostname.toLowerCase().replace(/^www\./, "");
      const segments = url.pathname.split("/").filter(Boolean);
      const github = domain === "github.com" && segments.length >= 2;
      const youtube = domain === "youtube.com" || domain === "youtu.be";
      const social = domain === "x.com" || domain === "twitter.com";
      const urlSegment = (value: string) => /^[a-zA-Z0-9._-]+$/.test(value) && value !== "." && value !== ".." ? value : slug(value);
      const directory = github ? join("github.com", urlSegment(segments[0]), urlSegment(segments[1]))
        : youtube ? join("youtube.com", slug(item.author || "unknown-channel"))
        : social && segments[0] ? join(domain, urlSegment(segments[0])) : domain;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(item.published.slice(0, 10)) ? item.published.slice(0, 10) : item.retrieved.slice(0, 10);
      const socialId = social ? /^\d+$/.test(segments[2] || "") && segments[1] === "status" ? segments[2] : null : null;
      const videoId = youtube ? domain === "youtu.be" ? segments[0] : url.searchParams.get("v") || (segments[0] === "shorts" ? segments[1] : null) : null;
      const name = socialId ? `${date}-${socialId}.md` : videoId ? `${date}-${urlSegment(videoId)}.md`
        : filename.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => ({ ...values, date })[key] ?? "");
      const file = safePath(root, join(directory, name));
      await mkdir(root, { recursive: true });
      await rejectSymlinks(root, file);
      await mkdir(dirname(file), { recursive: true });
      await rejectSymlinks(root, file);
      const metadata: Record<string, string | string[] | null> = {
        id: item.id, site: item.site, sourceId: item.sourceId, source: item.source,
        title: item.title, kind: item.kind, published: item.published, retrieved: item.retrieved,
        tags: item.tags, state: item.state,
      };
      const frontmatter = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
      let handle;
      try {
        handle = await open(file, "wx", 0o600);
      } catch (error) {
        if (!recoverPending || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await rejectSymlinks(root, file);
        const existing = await readFile(file, "utf8");
        if (!existing.startsWith(`---\nid: ${JSON.stringify(item.id)}\n`) || !existing.includes("\n---\n\n") || !existing.slice(existing.indexOf("\n---\n\n") + "\n---\n\n".length).trim()) throw new Error("Existing file is not a complete JOMO file for this item");
        return relative(root, file);
      }
      try {
        await handle.writeFile(`---\n${frontmatter}\n---\n\n${item.body}`, "utf8");
      } finally {
        await handle.close();
      }
      return relative(root, file);
    },
    async mirrorState(path: string, id: string, state: string): Promise<void> {
      const file = safePath(root, path);
      await rejectSymlinks(root, file);
      const text = await readFile(file, "utf8");
      if (!text.startsWith(`---\nid: ${JSON.stringify(id)}\n`) || !/^state: .*$/m.test(text)) throw new Error("Not a JOMO-owned content file");
      const marker = text.indexOf("\n---\n");
      if (marker < 0) throw new Error("Invalid content file");
      const frontmatter = text.slice(0, marker).replace(/^state: .*$/m, `state: ${JSON.stringify(state)}`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(frontmatter + text.slice(marker), "utf8");
      } finally {
        await handle.close();
      }
      try {
        await rejectSymlinks(root, file);
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async readBody(path: string): Promise<string> {
      const file = safePath(root, path);
      await rejectSymlinks(root, file);
      const text = await readFile(file, "utf8");
      const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/.exec(text);
      if (!match) throw new Error("Invalid content file");
      return text.slice(match[0].length);
    },
  };
}

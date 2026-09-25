import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Defuddle } from "defuddle/node";
import { normalizeUrl } from "./normalize-url";
import type { ExtractedLink } from "./queue-ingest";

const exec = promisify(execFile);

// Realistic desktop-Chrome UA: personal archivers are UA-fingerprinted by
// bot rules that match "(compatible; ...)", and a genuine browser string is
// the accepted practice (Readeck, Readwise, etc.) for read-it-later fetches.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PREVIEW_UA = "facebookexternalhit/1.1";

function forbidden(error: unknown): boolean {
  return /403|forbidden|401|unauthorized/i.test(error instanceof Error ? error.message : String(error));
}

// X/Twitter blocks plain fetchers with 403; fxtwitter is the read-only proxy
// for tweet text, author, and creation date.
async function xPost(url: URL, fetchPage: typeof fetch, signal?: AbortSignal): Promise<ExtractedLink> {
  const response = await fetchPage(`https://api.fxtwitter.com${url.pathname}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000), headers: { "user-agent": BROWSER_UA } });
  if (!response.ok) throw new Error(`fxtwitter HTTP ${response.status}`);
  const data = await response.json() as { code?: number; message?: string; tweet?: { text?: string; author?: { name?: string; screen_name?: string }; created_at?: string; created_timestamp?: number } };
  const tweet = data.tweet;
  if (!tweet?.text?.trim()) throw new Error(data.message || "fxtwitter returned no tweet");
  const published = tweet.created_at || (tweet.created_timestamp ? new Date(tweet.created_timestamp * 1000).toISOString() : undefined);
  return { title: tweet.text.replace(/\s+/g, " ").trim().slice(0, 200), site: "X", author: tweet.author?.name || tweet.author?.screen_name || undefined, published, body: tweet.text };
}

function commentMarkdown(comments: Array<{ author?: { login?: string }; createdAt?: string; body?: string }>): string {
  if (!comments.length) return "";
  return "\n## Comments\n\n" + comments.map((comment) => `### ${comment.author?.login || "unknown"} (${comment.createdAt || ""})\n\n${comment.body || "_No text_"}`).join("\n\n---\n\n") + "\n";
}

async function github(url: URL, signal?: AbortSignal): Promise<ExtractedLink | null> {
  if (url.hostname !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (parts[2] === "blob" && parts.length >= 5) {
    const filePath = parts.slice(4).join("/");
    const { stdout } = await exec("gh", ["api", `repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(parts[3])}`], { timeout: 20_000, maxBuffer: 5_000_000, signal });
    const data = JSON.parse(stdout) as { content?: string; encoding?: string };
    if (data.encoding !== "base64" || !data.content) throw new Error("GitHub file could not be retrieved as text");
    const body = Buffer.from(data.content, "base64").toString("utf8");
    return { title: filePath.split("/").pop() || url.pathname, site: "GitHub", published: undefined, body: `> [!note] Archived verbatim from ${url.toString()} at ref ${parts[3]}.\n\n${body}\n` };
  }
  if (parts.length === 2) {
    const { stdout } = await exec("gh", ["repo", "view", `${owner}/${repo}`, "--json", "nameWithOwner,description,url,homepageUrl,createdAt,stargazerCount,forkCount,licenseInfo,primaryLanguage,repositoryTopics,isArchived"], { timeout: 20_000, maxBuffer: 2_000_000, signal });
    const data = JSON.parse(stdout) as { nameWithOwner: string; description?: string; homepageUrl?: string; createdAt?: string; stargazerCount?: number; forkCount?: number; licenseInfo?: { spdxId?: string }; primaryLanguage?: { name: string }; repositoryTopics?: Array<{ name?: string }>; isArchived?: boolean };
    const topics = data.repositoryTopics?.map((topic) => topic.name).filter(Boolean) ?? [];
    return {
      title: data.nameWithOwner,
      site: "GitHub",
      published: data.createdAt,
      body: [data.description || "_No description._", data.homepageUrl ? `Homepage: ${data.homepageUrl}` : "", `Stars: ${data.stargazerCount ?? 0}`, `Forks: ${data.forkCount ?? 0}`, data.primaryLanguage?.name ? `Language: ${data.primaryLanguage.name}` : "", data.licenseInfo?.spdxId ? `License: ${data.licenseInfo.spdxId}` : "", topics.length ? `Topics: ${topics.join(", ")}` : "", data.isArchived ? "This repository is archived." : ""].filter(Boolean).join("\n\n"),
    };
  }
  if ((parts[2] === "issues" || parts[2] === "pull") && /^\d+$/.test(parts[3] ?? "")) {
    const command = parts[2] === "pull" ? "pr" : "issue";
    const { stdout } = await exec("gh", [command, "view", parts[3], "--repo", `${owner}/${repo}`, "--json", "title,body,author,createdAt,comments"], { timeout: 20_000, maxBuffer: 5_000_000, signal });
    const data = JSON.parse(stdout) as { title: string; body?: string; author?: { login: string }; createdAt?: string; comments?: Array<{ author?: { login?: string }; createdAt?: string; body?: string }> };
    return { title: data.title, site: "GitHub", author: data.author?.login, published: data.createdAt, body: `${data.body || "_No description._"}${commentMarkdown(data.comments ?? [])}` };
  }
  return null;
}

async function fetchPage(candidate: string, fetchPageImpl: typeof fetch, signal?: AbortSignal): Promise<Response> {
  const response = await fetchPageImpl(candidate, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000), headers: { "user-agent": BROWSER_UA } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

// Extracted dates are only trusted when the page vouches for them: declared
// in <head> (JSON-LD or article:published_time), or visible as a byline near
// the top or the very end of the document. A date picked up mid-body usually
// belongs to a related-post rail, not the article (OpenAI's pages embed one
// ~260 KB in, which surfaced as a fake "published" date).
const TOP_DATE_WINDOW = 12_000;
const TAIL_DATE_WINDOW = 8_000;
export function trustedPublished(html: string, published: string | undefined): string | undefined {
  if (!published) return undefined;
  const at = Date.parse(published);
  if (!Number.isFinite(at)) return undefined;
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd < 0 ? html : html.slice(0, headEnd);
  if (/"datePublished"\s*:/i.test(head) || /property=["']article:published_time["']/i.test(head)) return published;
  const date = new Date(at);
  const forms = [date.toISOString().slice(0, 10), date.toISOString().slice(0, 7), date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })];
  const windows = html.slice(0, TOP_DATE_WINDOW) + html.slice(-TAIL_DATE_WINDOW);
  return forms.some((form) => windows.includes(form)) ? published : undefined;
}

async function extractDocument(candidate: string, parsed: URL, fetchPageImpl: typeof fetch, signal?: AbortSignal): Promise<ExtractedLink> {
  const response = await fetchPage(candidate, fetchPageImpl, signal);
  const contentType = response.headers.get("content-type") ?? "";
  const markdown = /text\/markdown/i.test(contentType) || /text\/plain/i.test(contentType) && parsed.pathname.endsWith(".md");
  if (!markdown && !/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error("Not an HTML or Markdown page");
  const size = Number(response.headers.get("content-length") ?? 0);
  if (size > 4_000_000) throw new Error("Page too large");
  const html = await response.text();
  if (html.length > 4_000_000) throw new Error("Page too large");
  if (markdown) return { title: /^#\s+(.+)$/m.exec(html)?.[1] || parsed.pathname.split("/").pop() || parsed.hostname, site: parsed.hostname, body: html };
  // Defuddle's Node entry constructs its own DOM for HTML strings.
  const result = await Defuddle(html, response.url || candidate, { markdown: true });
  if (!result.content?.trim()) throw new Error("No content could be extracted");
  const modelPath = parsed.hostname === "huggingface.co" && /^\/[^/]+\/[^/]+\/?$/.test(parsed.pathname) ? parsed.pathname.slice(1).replace(/\/$/, "") : null;
  const title = modelPath && result.title?.trim() === "Hugging Face" ? modelPath : result.title || parsed.hostname;
  return { title: title.replace(/\s+/g, " ").trim(), site: result.site || parsed.hostname, author: result.author || undefined, published: trustedPublished(html, result.published || undefined), body: result.content };
}

// Last-ditch capture for origins that refuse bots (paywalls, bot-blocking
// CDNs): fetch as a share-preview crawler and keep the metadata as a
// bookmark instead of the full body.
async function previewStub(url: URL, fetchPageImpl: typeof fetch, signal?: AbortSignal): Promise<ExtractedLink> {
  const response = await fetchPageImpl(url.toString(), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), headers: { "user-agent": PREVIEW_UA } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const metas: Record<string, string> = {};
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = tag[0].match(/(?:name|property)=["']([^"']+)/i)?.[1];
    const content = tag[0].match(/content=["']([^"']*)/i)?.[1];
    if (name && content !== undefined) metas[name.toLowerCase()] = content;
  }
  const title = metas["og:title"] || /<title[^>]*>([^<]+)/i.exec(html)?.[1]?.trim();
  if (!title) throw new Error("No share-preview metadata either");
  const description = metas["og:description"] || metas["description"] || "";
  const body = `${description ? `${description}\n\n` : ""}> [!note] The origin refused the full fetch; this note keeps the share-preview metadata as a bookmark.\n`;
  return { title: title.replace(/^["']|["']$/g, ""), site: url.hostname, author: metas["author"] || undefined, published: metas["article:published_time"] || undefined, body, preview: true };
}

export async function extractUrl(url: string, fetchPageImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ExtractedLink> {
  const parsed = new URL(normalizeUrl(url));
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP(S) links are supported");
  if (parsed.hostname === "x.com" || parsed.hostname === "twitter.com" || parsed.hostname.endsWith(".twitter.com")) return xPost(parsed, fetchPageImpl, signal);
  if (fetchPageImpl === fetch) {
    const result = await github(parsed, signal);
    if (result) return result;
  }
  // Candidates in order: the canonical URL, then the Medium /amp variant.
  const candidates = [parsed.toString()];
  if (/(?:^|\.)medium\.com$/.test(parsed.hostname) && !parsed.pathname.endsWith("/amp")) {
    const amp = new URL(parsed.toString());
    amp.pathname = `${amp.pathname.replace(/\/$/, "")}/amp`;
    candidates.push(amp.toString());
  }
  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      return await extractDocument(candidate, parsed, fetchPageImpl, signal);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (forbidden(firstError)) {
    try {
      return await previewStub(parsed, fetchPageImpl, signal);
    } catch { /* fall through to the original failure */ }
  }
  throw firstError instanceof Error ? firstError : new Error(String(firstError));
}
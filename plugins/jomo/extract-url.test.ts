import { describe, expect, it } from "vitest";
import { extractUrl, trustedPublished } from "./extract-url";

describe("link extraction", () => {
  it("accepts a plain Markdown document linked from the queue", async () => {
    const result = await extractUrl("https://example.org/docs/about.md", async () => new Response("# About this project\n\nReadable Markdown.", { headers: { "content-type": "text/markdown" } }));
    expect(result).toMatchObject({ title: "About this project", body: "# About this project\n\nReadable Markdown." });
  });

  it("uses a model path when Hugging Face returns only its generic page title", async () => {
    const result = await extractUrl("https://huggingface.co/openbmb/MiniCPM5-2B", async () => new Response('<html><head><title>Hugging Face</title></head><body><article><p>Model card with enough text to represent a real model page.</p></article></body></html>', { headers: { "content-type": "text/html" } }));
    expect(result.title).toBe("openbmb/MiniCPM5-2B");
  });

  it("extracts Markdown and metadata from an HTML response", async () => {
    const fetchPage = async () => new Response('<html><head><title>A story</title></head><body><main><article><h1>A story</h1><p>This is the real body of a story, with enough text to extract and read.</p></article></main></body></html>', { headers: { "content-type": "text/html" } });
    const result = await extractUrl("https://example.org/a", fetchPage);
    expect(result.title).toBe("A story");
    expect(result.body).toContain("real body");
  });

  it("routes X posts through fxtwitter instead of the blocked page", async () => {
    const fetchPage = async (input: RequestInfo | URL) => {
      const target = String(input);
      if (target === "https://api.fxtwitter.com/elonmusk/status/123") return Response.json({ code: 200, tweet: { text: "A short post.", author: { name: "Elon Musk", screen_name: "elonmusk" }, created_at: "2026-09-20T12:00:00.000Z" } });
      throw new Error(`unexpected fetch: ${target}`);
    };
    const result = await extractUrl("https://x.com/elonmusk/status/123?mx=2", fetchPage);
    expect(result).toMatchObject({ title: "A short post.", site: "X", author: "Elon Musk", published: "2026-09-20T12:00:00.000Z", body: "A short post." });
  });

  it("reports a real reason when fxtwitter has no tweet", async () => {
    const fetchPage = async () => Response.json({ code: 404, message: "NOT_FOUND", tweet: null });
    await expect(extractUrl("https://x.com/nobody/status/1", fetchPage)).rejects.toThrow(/NOT_FOUND/);
  });
});

describe("extraction resilience", () => {
  const paywalledHtml = '<html><head><title>Blocked story</title><meta property="og:title" content="Blocked story"><meta property="og:description" content="The gist of the paywalled piece."><meta property="article:published_time" content="2026-09-20T10:00:00Z"></head><body></body></html>';

  it("falls back to a share-preview bookmark when the origin 403s", async () => {
    const calls: string[] = [];
    const fetchPage = async (input: RequestInfo | URL, init?: RequestInit) => {
      const userAgent = (init?.headers as Record<string, string>)?.["user-agent"] ?? "";
      calls.push(`${userAgent}`);
      if (userAgent.includes("facebookexternalhit")) return new Response(paywalledHtml, { headers: { "content-type": "text/html" } });
      return new Response("no", { status: 403 });
    };
    const result = await extractUrl("https://www.bloomberg.com/news/articles/x", fetchPage);
    expect(result.title).toBe("Blocked story");
    expect(result.published).toBe("2026-09-20T10:00:00Z");
    expect(result.body).toContain("share-preview metadata as a bookmark");
    expect(result.body).toContain("The gist of the paywalled piece.");
  });

  it("keeps the original failure when the preview stub has nothing either", async () => {
    const fetchPage = async () => new Response("no", { status: 403 });
    await expect(extractUrl("https://example.org/a", fetchPage)).rejects.toThrow(/403/);
  });

  it("tries the Medium /amp variant when the canonical page fails", async () => {
    const requested: string[] = [];
    const fetchPage = async (input: RequestInfo | URL) => {
      requested.push(String(input));
      const target = String(input);
      if (target.endsWith("/amp")) return new Response('<html><head><title>AMP story</title></head><body><article><p>Readable AMP body with plenty of text to extract.</p></article></body></html>', { headers: { "content-type": "text/html" } });
      return new Response("no", { status: 500 });
    };
    const result = await extractUrl("https://blog.medium.com/story", fetchPage);
    expect(result.title).toBe("AMP story");
    expect(requested[0]).toBe("https://blog.medium.com/story");
    expect(requested[1]).toBe("https://blog.medium.com/story/amp");
  });
});

describe("page fetch user agent", () => {
  it("presents a realistic browser UA, not a self-declared bot string", async () => {
    const fetchPage = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const userAgent = (init?.headers as Record<string, string>)?.["user-agent"] ?? "";
      expect(userAgent).not.toMatch(/compatible/i);
      expect(userAgent).toMatch(/Chrome\/\d+/);
      return new Response('<html><head><title>A story</title></head><body><main><article><h1>A story</h1><p>This is the real body of a story, with enough text to extract and read.</p></article></main></body></html>', { headers: { "content-type": "text/html" } });
    };
    const result = await extractUrl("https://example.org/a", fetchPage);
    expect(result.title).toBe("A story");
  });
});

describe("publish-date trust rule", () => {
  const html = (head: string, body: string) => `<html><head>${head}</head><body>${body}</body></html>`;
  const filler = "<p>filler</p>".repeat(3000);

  it("keeps a date declared in head metadata anywhere on the page", () => {
    const page = html(`<script>{"datePublished":"2026-07-01T00:00:00Z"}</script>`, `<article><p>Body.</p>${filler}</article>`);
    expect(trustedPublished(page, "2026-07-01T00:00:00Z")).toBe("2026-07-01T00:00:00Z");
  });

  it("keeps a byline date near the top of the body", () => {
    const page = html("", `<article><time>Jul 27, 2026</time><p>Body.</p>${filler}</article>`);
    expect(trustedPublished(page, "Jul 27, 2026")).toBe("Jul 27, 2026");
  });

  it("keeps a byline date at the very end of the body", () => {
    const page = html("", `<article><p>Body.</p>${filler}<time>Aug 17, 2026</time></article>`);
    expect(trustedPublished(page, "Aug 17, 2026")).toBe("Aug 17, 2026");
  });

  it("rejects a mid-body date from a related-post rail", () => {
    const page = html("", `<article><p>Body.</p>${filler}<span>Related</span><time>Jul 21, 2026</time>${filler}</article>`);
    expect(trustedPublished(page, "Jul 21, 2026")).toBeUndefined();
  });

  it("rejects unparseable dates outright", () => {
    expect(trustedPublished(html("", "<article>Body.</article>"), "sometime last week")).toBeUndefined();
  });

  it("flows the rejection through extraction so the saved date falls back to retrieval", async () => {
    const page = html("", `<article><p>Real body text with enough words to extract cleanly for this test.</p>${filler}<time>Jul 21, 2026</time>${filler}</article>`);
    const result = await extractUrl("https://example.org/a", async () => new Response(page, { headers: { "content-type": "text/html" } }));
    expect(result.published).toBeUndefined();
  });
});

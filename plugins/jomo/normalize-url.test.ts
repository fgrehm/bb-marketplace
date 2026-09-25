import { describe, expect, it } from "vitest";
import { normalizeUrl, resolveUrl } from "./normalize-url";

describe("normalizeUrl", () => {
  it("strips tracking parameters and the hash", () => {
    expect(normalizeUrl("https://example.org/a?utm_source=x&utm_medium=rss&fbclid=abc&keep=1#section"))
      .toBe("https://example.org/a?keep=1");
    expect(normalizeUrl("https://example.org/a?si=abc&gclid=x")).toBe("https://example.org/a");
  });

  it("keeps non-tracking query parameters untouched", () => {
    expect(normalizeUrl("https://example.org/podcast?id=42")).toBe("https://example.org/podcast?id=42");
  });
});

describe("resolveUrl", () => {
  it("follows redirects to the normalized final URL", async () => {
    const hops: Record<string, Response> = {
      "https://short.example/x": new Response(null, { status: 302, headers: { location: "https://real.example/article?utm_source=x" } }),
      "https://real.example/article": new Response(null, { status: 200 }),
    };
    const fetchPage = async (input: RequestInfo | URL) => hops[String(input)] ?? new Response(null, { status: 404 });
    expect(await resolveUrl("https://short.example/x?ref=feed", fetchPage)).toBe("https://real.example/article");
  });

  it("stops at the current URL when the origin rejects HEAD", async () => {
    const fetchPage = async () => { throw new Error("blocked"); };
    expect(await resolveUrl("https://example.org/a?utm_source=x", fetchPage)).toBe("https://example.org/a");
  });
});
describe("YouTube canonicalization", () => {
  it("folds every YouTube shape to one watch URL", () => {
    const expected = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(normalizeUrl("https://youtu.be/dQw4w9WgXcQ?si=sharesecret")).toBe(expected);
    expect(normalizeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=sharesecret&list=PL123")).toBe(expected);
    expect(normalizeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(expected);
    expect(normalizeUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(expected);
  });

  it("keeps a deep-link timestamp so the exact moment survives", () => {
    expect(normalizeUrl("https://youtu.be/dQw4w9WgXcQ?t=90")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90");
  });

  it("leaves channel and feed URLs alone", () => {
    expect(normalizeUrl("https://www.youtube.com/@OpenAI")).toBe("https://www.youtube.com/@OpenAI");
    expect(normalizeUrl("https://www.youtube.com/feeds/videos.xml?channel_id=UC123")).toBe("https://www.youtube.com/feeds/videos.xml?channel_id=UC123");
  });
});

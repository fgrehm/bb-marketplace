import { describe, expect, it } from "vitest";
import { plainExcerpt } from "./excerpt-plain";

describe("plainExcerpt", () => {
  it("collapses links to their labels and drops images", () => {
    const body = "Cover: ![logo](https://host/logo.png) A [paper](https://arxiv.org/x) and a [site][1] summary.";
    expect(plainExcerpt(body)).toBe("Cover: A paper and a site summary.");
  });

  it("does not leave mangled link fragments from naive stripping", () => {
    const body = "MiniCPM Tech Report (https://arxiv.org/pdf/1) | Wiki(Chinese) (https://wiki)";
    expect(plainExcerpt(body)).toBe("MiniCPM Tech Report | Wiki(Chinese)");
  });

  it("strips emphasis, code markers, headings, and quotes while keeping text", () => {
    const body = "# Heading\n\n> quote\n\nSome **bold**, _italics_, and `code` text.";
    expect(plainExcerpt(body)).toBe("Heading quote Some bold, italics, and code text.");
  });

  it("removes fenced code blocks and inline html", () => {
    const body = "Intro ```js\nconst x = 1;\n``` <b>bold</b> end";
    expect(plainExcerpt(body)).toBe("Intro bold end");
  });

  it("collapses whitespace and truncates to the limit", () => {
    const body = `${"word ".repeat(200).trim()}`;
    const result = plainExcerpt(body, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).not.toMatch(/\s{2,}/);
  });
});
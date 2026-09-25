import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "./markdown-body";

describe("saved article renderer", () => {
  it("renders Markdown and safe inline HTML without scripts", () => {
    const html = renderToStaticMarkup(<MarkdownBody body={'# Heading\n\nA **bold** [link](https://example.org).\n\n<em>emphasis</em><script>alert(1)</script>'} />);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });
});

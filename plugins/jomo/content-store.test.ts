import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentStore } from "./content-store";

const item = {
  id: "itm_abcdef123456", site: "Example", sourceId: "example", source: "https://example.org/post",
  title: "An actual article", kind: "article", published: "2026-09-23T08:14:00Z",
  retrieved: "2026-09-23T09:02:11Z", tags: ["reading"], state: "new",
  body: "First paragraph.\n\nSecond paragraph.",
};

describe("JOMO content files", () => {
  it("writes body and metadata to a unique markdown file, then reads the body back", async () => {
    const root = await mkdtemp(join(tmpdir(), "jomo-content-"));
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    const path = await store.write(item);
    expect(path).toBe("example.org/2026-09-23-an-actual-article.md");
    const text = await readFile(join(root, path), "utf8");
    expect(text).toContain('source: "https://example.org/post"');
    expect(text).not.toContain("\nnote:");
    expect(text).toContain("\n---\n\nFirst paragraph.\n\nSecond paragraph.");
    expect(await store.readBody(path)).toBe(item.body);
    await expect(store.write(item)).rejects.toThrow();
    await store.mirrorState(path, item.id, "saved");
    expect(await store.readBody(path)).toBe(item.body);
    expect(await readFile(join(root, path), "utf8")).toContain('state: "saved"');
  });

  it("follows the vault's GitHub, YouTube, and social paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "jomo-layout-"));
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{domain}}/{{date}}-{{slug}}.md" });
    expect(await store.write({ ...item, id: "itm_github123", source: "https://github.com/fabio/project", title: "Project" })).toBe("github.com/fabio/project/2026-09-23-project.md");
    expect(await store.write({ ...item, id: "itm_youtube123", source: "https://youtu.be/AbCdEF123", author: "Some Channel" })).toBe("youtube.com/some-channel/2026-09-23-AbCdEF123.md");
    expect(await store.write({ ...item, id: "itm_social123", source: "https://x.com/fabio/status/12345" })).toBe("x.com/fabio/2026-09-23-12345.md");
  });

  it("rejects traversal and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "jomo-safe-"));
    const outside = await mkdtemp(join(tmpdir(), "jomo-outside-"));
    await mkdir(join(root, "safe"));
    await symlink(outside, join(root, "escape"));
    const store = createContentStore({ contentRoot: root, filenamePattern: "{{slug}}.md" });
    await expect(store.readBody("../secret.md")).rejects.toThrow();
    await expect(store.readBody("escape/secret.md")).rejects.toThrow();
    await expect(store.write({ ...item, id: "../../../evil" })).rejects.toThrow();
    const linkedRoot = createContentStore({ contentRoot: join(root, "escape"), filenamePattern: "{{slug}}.md" });
    await expect(linkedRoot.write(item)).rejects.toThrow();
  });
});

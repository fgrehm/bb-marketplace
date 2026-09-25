import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const gh = vi.mocked(execFile);

async function extract(url: string) {
  const { extractUrl } = await import("./extract-url");
  return extractUrl(url, fetch);
}

function ghReply(payload: unknown) {
  gh.mockImplementation(((_command: string, args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string }) => void) => {
    const table: Array<[string, unknown]> = [
      ["contents", { content: Buffer.from("# A file\n\nWith content.").toString("base64"), encoding: "base64" }],
      ["--json", (() => {
        const json = JSON.stringify(args.includes("repo") ? { nameWithOwner: "owner/repo", description: "A repo", homepageUrl: "https://example.org", createdAt: "2020-01-01T00:00:00Z", stargazerCount: 38, forkCount: 4, licenseInfo: { spdxId: "MIT" }, primaryLanguage: { name: "C++" }, repositoryTopics: [{ name: "slides" }, { name: "editor" }], isArchived: false } : { title: "We need backorder support", body: "The original issue body.", author: { login: "fabio" }, createdAt: "2026-09-01T00:00:00Z", comments: [{ author: { login: "alice" }, createdAt: "2026-09-02T00:00:00Z", body: "Good point." }] });
        return JSON.parse(json);
      })()],
    ];
    const key = args.some((argument) => argument.startsWith("repos/")) ? "contents" : "--json";
    callback(null, { stdout: JSON.stringify((table.find(([name]) => name === key) ?? [null, null])[1]) });
  }) as typeof execFile);
}

describe("GitHub extraction parity", () => {
  it("archives a repository file blob verbatim", async () => {
    ghReply(null);
    const result = await extract("https://github.com/owner/repo/blob/main/docs/spec.md");
    expect(result.title).toBe("spec.md");
    expect(result.site).toBe("GitHub");
    expect(result.body).toContain("Archived verbatim from https://github.com/owner/repo/blob/main/docs/spec.md");
    expect(result.body).toContain("# A file");
  });

  it("includes issue comments in the body", async () => {
    ghReply(null);
    const result = await extract("https://github.com/owner/repo/issues/12");
    expect(result.title).toBe("We need backorder support");
    expect(result.author).toBe("fabio");
    expect(result.body).toContain("The original issue body.");
    expect(result.body).toContain("## Comments");
    expect(result.body).toContain("### alice (2026-09-02T00:00:00Z)");
    expect(result.body).toContain("Good point.");
  });

  it("renders the richer repository note", async () => {
    ghReply(null);
    const result = await extract("https://github.com/owner/repo");
    expect(result.published).toBe("2020-01-01T00:00:00Z");
    expect(result.body).toContain("Forks: 4");
    expect(result.body).toContain("License: MIT");
    expect(result.body).toContain("Topics: slides, editor");
  });
});
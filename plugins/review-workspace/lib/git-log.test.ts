// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseGitLog } from "./git-log";

describe("parseGitLog", () => {
  it("parses field/record separated git log output", () => {
    const raw = [
      "846e364c9db491759b7f391cd1ebb622e943badc\x1f846e364\x1f2 hours ago\x1ffix: ui\x1fFabio",
      "\x1e",
      "4760bdb000000000000000000000000000000000\x1f4760bdb\x1fyesterday\x1frefactor: sem\x1fFabio",
    ].join("");
    expect(parseGitLog(raw)).toEqual([
      {
        sha: "846e364c9db491759b7f391cd1ebb622e943badc",
        short: "846e364",
        date: "2 hours ago",
        subject: "fix: ui",
        author: "Fabio",
      },
      {
        sha: "4760bdb000000000000000000000000000000000",
        short: "4760bdb",
        date: "yesterday",
        subject: "refactor: sem",
        author: "Fabio",
      },
    ]);
  });

  it("drops empty and malformed records", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("not-a-sha\x1fnope\x1f\x1f\x1f")).toEqual([]);
  });
});

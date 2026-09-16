// Reads recent commits from a git checkout for the review target picker, so
// users can pick a commit from a list instead of pasting SHAs.
import { spawn } from "node:child_process";

export type CommitBrief = {
  sha: string;
  short: string;
  // Relative date as git renders it ("2 hours ago").
  date: string;
  subject: string;
  author: string;
};

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git exited with code ${code}`));
    });
  });
}

export function parseGitLog(raw: string): CommitBrief[] {
  return raw
    .split(RECORD_SEP)
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = "", short = "", date = "", subject = "", author = ""] =
        record.split(FIELD_SEP);
      return {
        sha: sha.trim(),
        short: short.trim(),
        date: date.trim(),
        subject: subject.trim(),
        author: author.trim(),
      };
    })
    .filter((commit) => /^[0-9a-f]{7,64}$/i.test(commit.sha));
}

export async function runRecentCommits(
  envPath: string,
  limit = 15,
): Promise<CommitBrief[]> {
  const raw = await runGit(
    [
      "log",
      `-${limit}`,
      "--date=relative",
      `--pretty=format:%H${FIELD_SEP}%h${FIELD_SEP}%ad${FIELD_SEP}%s${FIELD_SEP}%an${RECORD_SEP}`,
    ],
    envPath,
  );
  return parseGitLog(raw);
}

import assert from "node:assert/strict";
import test from "node:test";
import { isCommitPrompt, splitTextPrompt, textServiceArgs } from "./pi-title.ts";

const prompt = "You create concise titles.\n\nTask:\nTask: migrate the billing job";

test("splits at BB's first Task marker, keeping a marker in the task", () => {
  assert.deepEqual(splitTextPrompt(prompt), {
    instructions: "You create concise titles.", task: "Task: migrate the billing job",
  });
  assert.equal(splitTextPrompt("No marker"), null);
  assert.equal(splitTextPrompt("Instructions\nTask:\n"), null);
});

test("tells a commit prompt from a title prompt", () => {
  const commit = `Write a concise git commit message for uncommitted changes.
Reply with only the commit message line.

Shortstat:
 1 file changed

Files (name-status):
M	server.ts

Patch excerpt:
+fix the thing`;
  assert.equal(isCommitPrompt(commit), true);
  assert.equal(isCommitPrompt(prompt), false);
  // A title whose task text mentions commits is still a title.
  assert.equal(isCommitPrompt("You create concise titles.\n\nTask:\nWrite commit messages fast"), false);
  // A diff containing the Task marker must not change the classification.
  assert.equal(isCommitPrompt(commit.replace("+fix the thing", '+label = "Task:"')), true);
});

test("uses text mode so pi does not echo the conversation back", () => {
  const args = textServiceArgs({
    prompt, model: null,
    sessionPath: "/tmp/pi-extras-title-test.jsonl",
    sessionDir: "/tmp/pi-extras-sessions",
  });
  // JSON mode replays the whole prompt on stdout, which for a commit prompt
  // carrying a diff is several times its own size.
  assert.ok(args.includes("text"), "expected text mode");
  assert.ok(!args.includes("json"), "must not use json mode");
  for (const flag of ["-p", "--no-tools", "--session", "--session-dir", "--no-approve",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--thinking", "off"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(args[args.indexOf("--session") + 1], "/tmp/pi-extras-title-test.jsonl");
  assert.equal(args[args.indexOf("--session-dir") + 1], "/tmp/pi-extras-sessions");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "You create concise titles.");
  assert.equal(args.at(-1), "Task:\nTask: migrate the billing job");
  assert.ok(!args.includes("--model"));
  assert.deepEqual(textServiceArgs({
    prompt: "Unknown format", model: "provider/model",
    sessionPath: "/tmp/pi-extras-title-test.jsonl",
    sessionDir: "/tmp/pi-extras-sessions",
  }).slice(-3), ["--model", "provider/model", "Unknown format"]);
});

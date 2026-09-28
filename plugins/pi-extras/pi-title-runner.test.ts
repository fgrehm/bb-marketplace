import assert from "node:assert/strict";
import test from "node:test";
import { generateText, probeTextReadiness } from "./pi-title-runner.ts";
import type { ProcessResult, ProcessRunner } from "./pi-process.ts";

const prompt = "You create concise titles.\n\nTask:\nAdd a title prompt";
const outcome = (changes: Partial<ProcessResult> = {}): ProcessResult => ({
  code: 0, stdout: "Add a title prompt\n", stderr: "", error: null, timedOut: false, ...changes,
});
const fake = (result: ProcessResult): ProcessRunner => async () => result;

test("returns the trimmed text pi printed", async () => {
  let args: string[] = [];
  const run: ProcessRunner = async (_command, supplied) => { args = supplied; return outcome(); };
  assert.deepEqual(await generateText({ prompt, model: "openai-codex/gpt-6-luna", run }), {
    text: "Add a title prompt",
  });
  assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-6-luna");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "You create concise titles.");
  assert.equal(args.at(-1), "Task:\nAdd a title prompt");
});

test("keeps a multi-line answer for bb to clean", async () => {
  const noisy = outcome({ stdout: '"Quoted title"\n\nAn explanation.\n' });
  const result = await generateText({ prompt, model: null, run: fake(noisy) });
  // pi-extras must not parse or rewrite the reply; bb strips quotes and extra
  // lines for a title and clamps a commit subject to 72 columns.
  assert.equal(result.text, '"Quoted title"\n\nAn explanation.');
});

test("fails closed on timeout, process failure, and an empty answer", async () => {
  for (const result of [
    outcome({ timedOut: true }),
    outcome({ code: 1, stderr: "No authentication" }),
    outcome({ error: "spawn pi ENOENT" }),
    outcome({ stdout: "   \n" }),
  ]) {
    await assert.rejects(() => generateText({ prompt, model: null, run: fake(result) }));
  }
});

test("reports readiness without treating extension warnings as failure", async () => {
  const ready = outcome({ stdout: "provider model context max-out thinking images\nopenai-codex gpt-6-luna 1M 65K yes no", stderr: "extension warning" });
  assert.deepEqual(await probeTextReadiness({ run: fake(ready) }), { ready: true });
  const empty = outcome({ stdout: "provider model context max-out thinking images", stderr: "Sign in with /login" });
  assert.deepEqual(await probeTextReadiness({ run: fake(empty) }), { ready: false, message: "Sign in with /login" });
});

test("readiness reports timeout and spawn failures instead of throwing", async () => {
  const timedOut = await probeTextReadiness({ run: fake(outcome({ timedOut: true })) });
  assert.equal(timedOut.ready, false);
  const run: ProcessRunner = async () => { throw new Error("spawn pi ENOENT"); };
  const missing = await probeTextReadiness({ run });
  assert.deepEqual(missing, { ready: false, message: "Unable to run pi: spawn pi ENOENT" });
});

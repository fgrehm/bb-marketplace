import assert from "node:assert/strict";
import test from "node:test";
import { generateTitle, probeTitleReadiness } from "./pi-title-runner.ts";
import type { ProcessResult, ProcessRunner } from "./pi-process.ts";

const prompt = "You create concise titles.\n\nTask:\nAdd a title prompt";
const envelope = (stopReason = "stop") => JSON.stringify({
  type: "agent_end",
  messages: [{ role: "assistant", provider: "openai-codex", model: "gpt-6-luna",
    stopReason, content: [{ type: "text", text: "Add a title prompt\n" }] }],
});
const outcome = (changes: Partial<ProcessResult> = {}): ProcessResult => ({
  code: 0, stdout: envelope(), stderr: "", error: null, timedOut: false, ...changes,
});
const fake = (result: ProcessResult): ProcessRunner => async () => result;

test("generates a title using the chosen model and system/user split", async () => {
  let args: string[] = [];
  const run: ProcessRunner = async (_command, supplied) => { args = supplied; return outcome(); };
  assert.deepEqual(await generateTitle({ prompt, model: "openai-codex/gpt-6-luna", run }), {
    title: "Add a title prompt", model: "openai-codex/gpt-6-luna",
  });
  assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-6-luna");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "You create concise titles.");
  assert.equal(args.at(-1), "Task:\nAdd a title prompt");
});

test("fails closed on timeout, process failure, or incomplete answer", async () => {
  for (const result of [
    outcome({ timedOut: true }),
    outcome({ code: 1, stderr: "No authentication" }),
    outcome({ error: "spawn pi ENOENT" }),
    outcome({ stdout: envelope("length") }),
  ]) {
    await assert.rejects(() => generateTitle({ prompt, model: null, run: fake(result) }));
  }
});

test("reports readiness without treating extension warnings as failure", async () => {
  const ready = outcome({ stdout: "provider model context max-out thinking images\nopenai-codex gpt-6-luna 1M 65K yes no", stderr: "extension warning" });
  assert.deepEqual(await probeTitleReadiness({ run: fake(ready) }), { ready: true });
  const empty = outcome({ stdout: "provider model context max-out thinking images", stderr: "Sign in with /login" });
  assert.deepEqual(await probeTitleReadiness({ run: fake(empty) }), { ready: false, message: "Sign in with /login" });
});

test("readiness reports timeout and spawn failures instead of throwing", async () => {
  const timedOut = await probeTitleReadiness({ run: fake(outcome({ timedOut: true })) });
  assert.equal(timedOut.ready, false);
  const run: ProcessRunner = async () => { throw new Error("spawn pi ENOENT"); };
  const missing = await probeTitleReadiness({ run });
  assert.deepEqual(missing, { ready: false, message: "Unable to run pi: spawn pi ENOENT" });
});

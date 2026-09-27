import assert from "node:assert/strict";
import test from "node:test";
import { parseTitleEnvelope, splitTitlePrompt, titleServiceArgs } from "./pi-title.ts";

const prompt = "You create concise titles.\n\nTask:\nTask: migrate the billing job";

test("splits at BB's first Task marker, keeping a marker in the task", () => {
  assert.deepEqual(splitTitlePrompt(prompt), {
    instructions: "You create concise titles.", task: "Task: migrate the billing job",
  });
  assert.equal(splitTitlePrompt("No marker"), null);
  assert.equal(splitTitlePrompt("Instructions\nTask:\n"), null);
});

test("runs without tools, session, or project context; model override is optional", () => {
  const args = titleServiceArgs({ prompt, model: null });
  for (const flag of ["-p", "--mode", "json", "--no-tools", "--no-session", "--no-approve",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--thinking", "off"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(args[args.indexOf("--system-prompt") + 1], "You create concise titles.");
  assert.equal(args.at(-1), "Task:\nTask: migrate the billing job");
  assert.ok(!args.includes("--model"));
  assert.deepEqual(titleServiceArgs({ prompt: "Unknown format", model: "provider/model" }).slice(-3),
    ["--model", "provider/model", "Unknown format"]);
});

const event = (blocks: unknown[], stopReason = "stop") => JSON.stringify({
  type: "agent_end",
  messages: [{ role: "assistant", provider: "openai-codex", model: "gpt-6-luna", stopReason, content: blocks }],
});

test("extracts the final text block, not thinking, from Pi's JSON events", () => {
  const stdout = [JSON.stringify({ type: "agent_start" }), event([
    { type: "thinking", thinking: "hmm" }, { type: "text", text: "A preamble" },
    { type: "text", text: "  Fix the billing job\n" },
  ])].join("\n");
  assert.deepEqual(parseTitleEnvelope(stdout), { text: "Fix the billing job", model: "openai-codex/gpt-6-luna" });
});

test("rejects missing, truncated and non-text answers", () => {
  assert.equal(parseTitleEnvelope("bad JSON\n"), null);
  assert.equal(parseTitleEnvelope(event([{ type: "thinking", thinking: "hmm" }])), null);
  assert.equal(parseTitleEnvelope(event([{ type: "text", text: "unfinished" }], "length")), null);
});

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSettings, runPiUpdate, writeSettings } from "./settings.ts";

test("reads and writes selected global settings without dropping unrelated fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-settings-"));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ theme: "dark", defaultModel: "old" }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir };
  assert.deepEqual(await readSettings(env), { defaultProvider: null, defaultModel: "old", defaultThinkingLevel: null, enabledModels: [] });
  await writeSettings({ defaultProvider: "openai-codex", defaultModel: "gpt-5.5", defaultThinkingLevel: "high", enabledModels: ["openai-codex/*"] }, env);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { theme: "dark", defaultProvider: "openai-codex", defaultModel: "gpt-5.5", defaultThinkingLevel: "high", enabledModels: ["openai-codex/*"] });
});

test("runs Pi updates with fixed arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bin-"));
  const bin = join(dir, "pi");
  await writeFile(bin, '#!/bin/sh\nprintf "%s" "$*"\n');
  await chmod(bin, 0o755);
  const output = await runPiUpdate("models", { ...process.env, PATH: dir });
  assert.equal(output, "update --models");
});

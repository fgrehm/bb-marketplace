import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSettings, runPiUpdate, unpinNpmPackages, writeSettings } from "./pi-settings.ts";

test("reads and writes selected global settings without dropping unrelated fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-settings-"));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ theme: "dark", defaultModel: "old" }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir };
  assert.deepEqual(await readSettings(env), { defaultProvider: null, defaultModel: "old", defaultThinkingLevel: null, enabledModels: [] });
  await writeSettings({ defaultProvider: "openai-codex", defaultModel: "gpt-5.5", defaultThinkingLevel: "high", enabledModels: ["openai-codex/*"] }, env);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { theme: "dark", defaultProvider: "openai-codex", defaultModel: "gpt-5.5", defaultThinkingLevel: "high", enabledModels: ["openai-codex/*"] });
});

test("temporarily unpins exact npm package sources", () => {
  assert.deepEqual(unpinNpmPackages([
    "npm:pi-ollama-cloud@0.12.0",
    { source: "npm:@scope/plugin@1.2.3", autoload: false },
    "git:github.com/example/plugin@main",
  ]), {
    names: ["pi-ollama-cloud", "@scope/plugin"],
    packages: [
      "npm:pi-ollama-cloud",
      { source: "npm:@scope/plugin", autoload: false },
      "git:github.com/example/plugin@main",
    ],
  });
});

test("runs Pi updates with fixed arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bin-"));
  const bin = join(dir, "pi");
  await writeFile(bin, '#!/bin/sh\nprintf "%s" "$*"\n');
  await chmod(bin, 0o755);
  const result = await runPiUpdate("models", { ...process.env, PATH: dir });
  assert.deepEqual(result, { ok: true, output: "update --models" });
});

test("returns Pi stderr when an update fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bin-"));
  const bin = join(dir, "pi");
  await writeFile(bin, '#!/bin/sh\necho "permission denied" >&2\nexit 1\n');
  await chmod(bin, 0o755);
  const result = await runPiUpdate("plugins", { ...process.env, PATH: dir });
  assert.deepEqual(result, { ok: false, output: "permission denied" });
});

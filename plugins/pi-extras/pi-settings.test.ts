import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSettings, runPiUpdate, unsetPiSettings, unpinNpmPackages, writeSettings } from "./pi-settings.ts";

test("reads and writes selected global settings without dropping unrelated fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-settings-"));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ theme: "dark", defaultModel: "old" }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir };
  assert.deepEqual(await readSettings(env), unsetPiSettings({ defaultModel: "old" }));
  await writeSettings(unsetPiSettings({ defaultProvider: "openai-codex", defaultModel: "gpt-5.5", defaultThinkingLevel: "high", enabledModels: ["openai-codex/*"] }), env);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { theme: "dark", defaultProvider: "openai-codex", defaultModel: "gpt-5.5", defaultThinkingLevel: "high", enabledModels: ["openai-codex/*"] });
});

test("reads the runtime settings that reach a BB thread", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-settings-"));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({
    compaction: { enabled: false, reserveTokens: 48000, modelOverrides: { "anthropic/claude-opus-4-8": { keepRecentTokens: 4000 } } },
    httpIdleTimeoutMs: 120000,
    shellPath: "/bin/bash",
    enableInstallTelemetry: false,
  }));
  const read = await readSettings({ ...process.env, PI_CODING_AGENT_DIR: dir });
  assert.deepEqual(read.compaction, { enabled: false, reserveTokens: 48000, keepRecentTokens: null });
  assert.equal(read.httpIdleTimeoutMs, 120000);
  assert.deepEqual(read.shell, { shellPath: "/bin/bash", shellCommandPrefix: null });
  assert.deepEqual(read.telemetry, { enableInstallTelemetry: false, enableAnalytics: null });

  // A round trip must not disturb keys the panel never edits.
  await writeSettings(read, { ...process.env, PI_CODING_AGENT_DIR: dir });
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(written.compaction, {
    enabled: false,
    reserveTokens: 48000,
    modelOverrides: { "anthropic/claude-opus-4-8": { keepRecentTokens: 4000 } },
  });
  assert.equal(written.httpIdleTimeoutMs, 120000);
  assert.equal(written.shellPath, "/bin/bash");
  assert.equal(written.enableInstallTelemetry, false);
});

test("leaves unrelated empty objects alone while pruning its own groups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-settings-"));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ compaction: { reserveTokens: 1 }, warnings: {}, extensions: [] }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir };
  const read = await readSettings(env);
  await writeSettings({ ...read, compaction: { enabled: null, reserveTokens: null, keepRecentTokens: null } }, env);
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal("compaction" in written, false);
  assert.deepEqual(written.warnings, {});
  assert.deepEqual(written.extensions, []);
});

test("removes a key when a setting goes back to pi's default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-settings-"));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({
    compaction: { enabled: false, reserveTokens: 48000 },
    httpIdleTimeoutMs: 120000,
    shellPath: "/bin/bash",
    shellCommandPrefix: "nice",
    enableAnalytics: true,
  }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir };
  const read = await readSettings(env);
  await writeSettings(
    {
      ...read,
      compaction: { enabled: null, reserveTokens: null, keepRecentTokens: null },
      httpIdleTimeoutMs: null,
      shell: { shellPath: null, shellCommandPrefix: null },
      telemetry: { enableInstallTelemetry: null, enableAnalytics: null },
    },
    env,
  );
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  // The emptied group and the cleared scalar keys are gone entirely.
  assert.equal("compaction" in written, false);
  assert.equal("httpIdleTimeoutMs" in written, false);
  assert.equal("shellPath" in written, false);
  assert.equal("shellCommandPrefix" in written, false);
  assert.equal("enableAnalytics" in written, false);
});

test("keeps thinking levels pi supports beyond the original four", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-settings-"));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ defaultThinkingLevel: "xhigh" }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir };
  const read = await readSettings(env);
  assert.equal(read.defaultThinkingLevel, "xhigh");
  await writeSettings(read, env);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { defaultThinkingLevel: "xhigh" });
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

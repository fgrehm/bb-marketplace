import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCodexUsage,
  parseCredentials,
  parseOllamaUsage,
  parseOpenCodeGoUsage,
  readPiUsage,
} from "./usage.ts";

test("parses legacy Codex credentials separately from Pi's OpenAI SIWC credential", () => {
  assert.deepEqual(parseCredentials({
    "openai-codex": { type: "oauth", access: "codex-token", accountId: "account-1" },
    openai: { type: "oauth", access: "siwc-token" },
    "opencode-go": { type: "api_key", key: "go-token" },
    "ollama-cloud": { type: "api_key", key: "ollama-token" },
  }), {
    codex: { access: "codex-token", accountId: "account-1" },
    openaiOAuthConfigured: true,
    opencodeGo: "go-token",
    ollamaCloud: "ollama-token",
  });
});

test("does not treat Pi's OpenAI SIWC credential as a Codex usage credential", () => {
  assert.deepEqual(parseCredentials({
    openai: { type: "oauth", access: "siwc-token" },
  }), {
    codex: null,
    openaiOAuthConfigured: true,
    opencodeGo: null,
    ollamaCloud: null,
  });
});

test("requires the account ID used by the legacy Codex usage endpoint", () => {
  assert.equal(parseCredentials({
    "openai-codex": { type: "oauth", access: "codex-token" },
  }).codex, null);
});

test("parses Codex primary and secondary quota windows", () => {
  assert.deepEqual(parseCodexUsage({ rate_limit: {
    primary_window: { used_percent: 5, reset_at: 1_788_446_140 },
    secondary_window: { used_percent: 83, reset_at: 1_788_781_640 },
  } }), [
    { label: "5 hours", usedPercent: 5, resetsAt: "2026-09-03T14:35:40.000Z" },
    { label: "Weekly", usedPercent: 83, resetsAt: "2026-09-07T11:47:20.000Z" },
  ]);
});

test("parses all OpenCode Go quota windows", () => {
  assert.deepEqual(parseOpenCodeGoUsage({ usage: {
    rolling: { percent: 4, resetsAt: "2026-09-03T15:00:00Z" },
    weekly: { percent: 10, resetsAt: "2026-09-08T00:00:00Z" },
    monthly: { percent: 25, resetsAt: "2026-10-01T00:00:00Z" },
  } }), [
    { label: "5 hours", usedPercent: 4, resetsAt: "2026-09-03T15:00:00.000Z" },
    { label: "Weekly", usedPercent: 10, resetsAt: "2026-09-08T00:00:00.000Z" },
    { label: "Monthly", usedPercent: 25, resetsAt: "2026-10-01T00:00:00.000Z" },
  ]);
});

test("parses Ollama's fractional monthly quota", () => {
  assert.deepEqual(parseOllamaUsage({ limits: { monthly: { usage: 0.08 } } }), [
    { label: "Monthly (30d)", usedPercent: 8, resetsAt: null },
  ]);
});

test("ignores Ollama's rolling activity period as a reset time", () => {
  // activity.period is a rolling "last 4 weeks" window (ending_at ≈ now),
  // not a quota reset - it must never surface as a reset timestamp.
  assert.deepEqual(parseOllamaUsage({
    activity: { cost: "0.00000", period: { type: "last_4_weeks", starting_at: "2026-08-09T00:00:00Z", ending_at: "2026-09-08T23:59:59Z" }, models: [] },
    limits: { monthly: { usage: 0.08, models: [{ name: "glm-5.3", request_count: 3 }] } },
  }), [
    { label: "Monthly (30d)", usedPercent: 8, resetsAt: null },
  ]);
});

test("fails open when Pi has no credential file", async () => {
  const usage = await readPiUsage({
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    fetch: async () => { throw new Error("fetch must not run"); },
  });
  assert.deepEqual(usage.sources.map(({ id, status }) => ({ id, status })), [
    { id: "codex", status: "not_configured" },
    { id: "opencode-go", status: "not_configured" },
    { id: "ollama-cloud", status: "not_configured" },
  ]);
});

test("shows a credential error when Pi auth data is malformed", async () => {
  const usage = await readPiUsage({
    readFile: async () => "not json",
    fetch: async () => { throw new Error("fetch must not run"); },
  });
  assert.deepEqual(usage.sources.map(({ status, message }) => ({ status, message })), [
    { status: "error", message: "Unable to read credentials." },
    { status: "error", message: "Unable to read credentials." },
    { status: "error", message: "Unable to read credentials." },
  ]);
});

test("explains that Pi's OpenAI SIWC sign-in cannot provide Codex usage", async () => {
  let requested = false;
  const usage = await readPiUsage({
    readFile: async () => JSON.stringify({ openai: { type: "oauth", access: "siwc-token" } }),
    fetch: async () => {
      requested = true;
      throw new Error("OpenAI SIWC tokens must not be sent to the Codex usage endpoint");
    },
  });
  assert.equal(requested, false);
  assert.deepEqual(usage.sources[0], {
    id: "codex",
    label: "Codex",
    status: "unavailable",
    message: "Pi's openai sign-in can authorize Responses API requests, but OpenAI does not document an API for reading Codex usage. View usage in ChatGPT settings.",
    windows: [],
  });
});

test("uses fake HTTP responses and marks only rejected credentials as expired", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const usage = await readPiUsage({
    readFile: async () => JSON.stringify({
      "openai-codex": { access: "codex-token", accountId: "account-1" },
      "opencode-go": { key: "go-token" },
      "ollama-cloud": { key: "ollama-token" },
    }),
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get("authorization") });
      const hostname = new URL(url).hostname;
      if (hostname === "chatgpt.com") return new Response("", { status: 401 });
      if (hostname === "opencode.ai") return Response.json({ usage: { rolling: { percent: 12, resetsAt: "2026-09-03T15:00:00Z" } } });
      return Response.json({ limits: { monthly: { usage: 0.25 } } });
    },
  });

  assert.deepEqual(usage.sources.map(({ id, status }) => ({ id, status })), [
    { id: "codex", status: "expired" },
    { id: "opencode-go", status: "ok" },
    { id: "ollama-cloud", status: "ok" },
  ]);
  assert.deepEqual(calls.map(({ authorization }) => authorization), [
    "Bearer codex-token", "Bearer go-token", "Bearer ollama-token",
  ]);
});

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

test("parses Ollama balance windows as percent used with quota resets", () => {
  assert.deepEqual(parseOllamaUsage({ included: {
    session: { remaining_percent: 60, resets_at: "2026-10-07T08:00:00Z" },
    weekly: { remaining_percent: 93 },
    monthly: { remaining_percent: 66 },
    balance_usd: 66.74607,
    allowance_usd: 300,
    period: { until: "2026-10-12T09:32:38Z" },
  } }), [
    { label: "5 hours", usedPercent: 40, resetsAt: "2026-10-07T08:00:00.000Z" },
    { label: "Weekly", usedPercent: 7, resetsAt: null },
    { label: "Monthly (30d)", usedPercent: 34, resetsAt: null },
  ]);
});

test("uses Ollama's included allowance and billing renewal when quota windows are absent", () => {
  assert.deepEqual(parseOllamaUsage({ included: {
    balance_usd: 55.5, allowance_usd: 60,
    period: { from: "2026-09-12T09:32:38Z", until: "2026-10-12T09:32:38Z" },
  }, purchased: { balance_usd: 0 } }), [
    { label: "Included allowance", usedPercent: 8, resetsAt: "2026-10-12T09:32:38.000Z" },
  ]);
});

test("clamps finite Ollama usage to the progress bar range", () => {
  for (const [remaining, usedPercent] of [[-5, 100], [105, 0]] as const) {
    assert.deepEqual(parseOllamaUsage({ included: { monthly: { remaining_percent: remaining } } }), [
      { label: "Monthly (30d)", usedPercent, resetsAt: null },
    ]);
  }
});

test("rejects malformed Ollama balances rather than showing misleading quota usage", () => {
  for (const payload of [
    null, {}, { limits: { monthly: { usage: 0.08 } } },
    { totals: { request_count: 12 } },
    { included: { balance_usd: 55.5 } },
    { included: { balance_usd: "55.5", allowance_usd: 60 } },
    { included: { balance_usd: 0, allowance_usd: 0 } },
    { included: { monthly: { remaining_percent: NaN } } },
    { included: { monthly: { remaining_percent: Infinity } } },
    { included: { monthly: { remaining_percent: 80, resets_at: 7 } } },
    { included: { monthly: { remaining_percent: 80 }, weekly: {} } },
    { included: { monthly: { remaining_percent: 80 }, balance_usd: "bad", allowance_usd: 60 } },
    { included: { balance_usd: 55.5, allowance_usd: 60, period: null } },
    { included: { balance_usd: 55.5, allowance_usd: 60, period: { until: {} } } },
    { included: { balance_usd: 55.5, allowance_usd: 60, period: { from: 7 } } },
    { included: { monthly: { remaining_percent: 80 } }, purchased: {} },
    { purchased: { balance_usd: 1.25 } },
  ]) assert.equal(parseOllamaUsage(payload), null);
});

test("does not use activity dates or invalid date strings as Ollama quota resets", () => {
  assert.deepEqual(parseOllamaUsage({
    included: { monthly: { remaining_percent: 92, resets_at: "not a date" } },
    activity: { period: { ending_at: "2026-09-08T23:59:59Z" } },
  }), [{ label: "Monthly (30d)", usedPercent: 8, resetsAt: null }]);
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
      assert.equal(url, "https://ollama.com/api/balance");
      return Response.json({ included: { monthly: { remaining_percent: 75 } } });
    },
  });

  assert.deepEqual(usage.sources.map(({ id, status }) => ({ id, status })), [
    { id: "codex", status: "expired" },
    { id: "opencode-go", status: "ok" },
    { id: "ollama-cloud", status: "ok" },
  ]);
  assert.deepEqual(usage.sources[2].windows, [
    { label: "Monthly (30d)", usedPercent: 25, resetsAt: null },
  ]);
  assert.deepEqual(calls.map(({ authorization }) => authorization), [
    "Bearer codex-token", "Bearer go-token", "Bearer ollama-token",
  ]);
});

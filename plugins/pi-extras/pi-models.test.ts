import assert from "node:assert/strict";
import test from "node:test";
import { parseAvailableModels } from "./pi-models.ts";
import {
  buildScopePatterns,
  isGlobPattern,
  isNegatedPattern,
  matchesModelPattern,
  modelReference,
  scopeForSettings,
  splitThinkingSuffix,
  unresolvedPatterns,
  type PiModelSummary,
} from "./model-scope.ts";

function model(provider: string, id: string, extra: Partial<PiModelSummary> = {}): PiModelSummary {
  return {
    provider,
    id,
    name: null,
    contextWindow: 200_000,
    maxTokens: 100_000,
    reasoning: true,
    images: false,
    ...extra,
  };
}

const MODELS: PiModelSummary[] = [
  model("anthropic", "claude-opus-4-8"),
  model("anthropic", "claude-sonnet-5", { images: true }),
  model("ollama-cloud", "gemma4:31b"),
  model("openai-codex", "gpt-5.3-codex-spark"),
  model("openai-codex", "gpt-5.5"),
];

const RPC_NOISE = [
  JSON.stringify({ type: "extension_ui_request", id: "abc", method: "setStatus" }),
  JSON.stringify({ type: "response", id: "other", command: "get_available_models", success: true, data: { models: [] } }),
].join("\n");

test("reads models from the correlated RPC response and sorts them", () => {
  const stdout = [
    RPC_NOISE,
    JSON.stringify({
      id: "bb-pi-extras-models",
      type: "response",
      command: "get_available_models",
      success: true,
      data: {
        models: [
          { id: "b", provider: "zeta", name: "B", contextWindow: 128000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
          { id: "a", provider: "alpha", reasoning: false, input: ["text"] },
          { id: "no-provider" },
        ],
      },
    }),
    "",
  ].join("\n");
  assert.deepEqual(parseAvailableModels(stdout), [
    { provider: "alpha", id: "a", name: null, contextWindow: null, maxTokens: null, reasoning: false, images: false },
    { provider: "zeta", id: "b", name: "B", contextWindow: 128000, maxTokens: 64000, reasoning: true, images: true },
  ]);
});

test("reports a failed RPC response as an error", () => {
  const stdout = JSON.stringify({
    id: "bb-pi-extras-models",
    type: "response",
    command: "get_available_models",
    success: false,
    error: "Model runtime unavailable",
  });
  assert.throws(() => parseAvailableModels(stdout), /Model runtime unavailable/);
});

test("ignores output that is not a JSONL record", () => {
  assert.deepEqual(parseAvailableModels("[pi-web-access] hello\nnot json\n{\n"), []);
});

test("splits a thinking suffix without eating model id colons", () => {
  assert.deepEqual(splitThinkingSuffix("anthropic/*:high"), { pattern: "anthropic/*", thinkingLevel: "high" });
  assert.deepEqual(splitThinkingSuffix("ollama-cloud/gemma4:31b"), { pattern: "ollama-cloud/gemma4:31b", thinkingLevel: null });
  assert.deepEqual(splitThinkingSuffix("gpt-5.5"), { pattern: "gpt-5.5", thinkingLevel: null });
});

test("matches exact references, globs, and fuzzy names like pi", () => {
  assert.deepEqual(matchesModelPattern("anthropic/claude-opus-4-8", MODELS).map(modelReference), ["anthropic/claude-opus-4-8"]);
  assert.deepEqual(matchesModelPattern("claude-opus-4-8", MODELS).map(modelReference), ["anthropic/claude-opus-4-8"]);
  assert.deepEqual(matchesModelPattern("ANTHROPIC/CLAUDE-OPUS-4-8", MODELS).map(modelReference), ["anthropic/claude-opus-4-8"]);
  assert.deepEqual(matchesModelPattern("openai-codex/*", MODELS).map(modelReference), ["openai-codex/gpt-5.3-codex-spark", "openai-codex/gpt-5.5"]);
  assert.deepEqual(matchesModelPattern("*-5.5", MODELS).map(modelReference), ["openai-codex/gpt-5.5"]);
  assert.deepEqual(matchesModelPattern("gpt-5*", MODELS).map(modelReference), ["openai-codex/gpt-5.3-codex-spark", "openai-codex/gpt-5.5"]);
  // A bare `*` matches every model id, the same as pi's glob matcher.
  assert.deepEqual(matchesModelPattern("*", MODELS).map(modelReference), MODELS.map(modelReference));
  assert.deepEqual(matchesModelPattern("**", MODELS).map(modelReference), MODELS.map(modelReference));
  assert.deepEqual(matchesModelPattern("openai-codex/*:high", MODELS).map(modelReference), ["openai-codex/gpt-5.3-codex-spark", "openai-codex/gpt-5.5"]);
  assert.deepEqual(matchesModelPattern("gemma4:31b", MODELS).map(modelReference), ["ollama-cloud/gemma4:31b"]);
  assert.deepEqual(matchesModelPattern("", MODELS), []);
  assert.deepEqual(matchesModelPattern("nope", MODELS), []);
});

test("flags patterns pi cannot resolve and treats ! as unsafe", () => {
  assert.deepEqual(unresolvedPatterns(["anthropic/*", "openai-codex/gpt-4", "!openai-codex/*"], MODELS), [
    "openai-codex/gpt-4",
  ]);
  assert.equal(isNegatedPattern("!openai-codex/*"), true);
  assert.equal(isNegatedPattern("openai-codex/*"), false);
  assert.equal(isGlobPattern("openai-codex/*"), true);
  assert.equal(isGlobPattern("openai-codex/gpt-5.5"), false);
});

test("keeps globs that still match the selection and expands the rest", () => {
  const all = new Set(MODELS.map(modelReference));
  assert.deepEqual(buildScopePatterns(all, ["openai-codex/*"], MODELS, null), [
    "openai-codex/*",
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-5",
    "ollama-cloud/gemma4:31b",
  ]);
  // Unchecking one model inside a glob expands the glob to exact references.
  assert.deepEqual(
    buildScopePatterns(new Set(["anthropic/claude-sonnet-5"]), ["anthropic/*"], MODELS, null),
    ["anthropic/claude-sonnet-5"],
  );
});

test("puts the default model first without dropping a covering glob", () => {
  const all = new Set(MODELS.map(modelReference));
  assert.deepEqual(buildScopePatterns(all, ["openai-codex/*"], MODELS, "openai-codex/gpt-5.5"), [
    "openai-codex/gpt-5.5",
    "openai-codex/*",
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-5",
    "ollama-cloud/gemma4:31b",
  ]);
});

test("preserves unresolved and negated patterns verbatim", () => {
  const checked = new Set(["openai-codex/gpt-5.5"]);
  assert.deepEqual(
    buildScopePatterns(checked, ["anthropic/claude-9", "!ollama-cloud/*", "openai-codex/*"], MODELS, "openai-codex/gpt-5.5"),
    ["openai-codex/gpt-5.5", "anthropic/claude-9", "!ollama-cloud/*"],
  );
});

test("drops the scope key only when every model is selected and nothing is unresolved", () => {
  const all = MODELS.map(modelReference);
  assert.equal(scopeForSettings(all, MODELS), null);
  assert.equal(scopeForSettings([], MODELS), null);
  assert.equal(scopeForSettings(["openai-codex/*", "anthropic/*", "ollama-cloud/*"], MODELS), null);
  assert.deepEqual(scopeForSettings(["openai-codex/*"], MODELS), ["openai-codex/*"]);
  assert.deepEqual(scopeForSettings([...all, "anthropic/claude-9"], MODELS), [...all, "anthropic/claude-9"]);
  // `*` matches every model id, so it covers everything and is not written.
  assert.equal(scopeForSettings(["*"], MODELS), null);
  assert.deepEqual(scopeForSettings(["openai-codex/*"], []), null);
});

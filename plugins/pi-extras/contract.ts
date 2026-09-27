import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable(),
}).strict();

const piModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string().nullable(),
  contextWindow: z.number().nullable(),
  maxTokens: z.number().nullable(),
  reasoning: z.boolean(),
  images: z.boolean(),
}).strict();

const modelListSchema = z.object({
  models: z.array(piModelSchema),
  error: z.string().nullable(),
}).strict();

const nullableFlag = z.boolean().nullable();
const nullableCount = z.number().int().nonnegative().nullable();

/**
 * Every field is nullable, and null means the key is absent from settings.json so
 * Pi applies its own default. The panel shows Pi's documented default as a
 * placeholder rather than writing it out.
 *
 * These are the global settings BB does not pass when it starts a thread, so
 * Pi's values are what a BB thread runs with. BB passes model, reasoning level,
 * instructions, and session directory itself, and it does its own message
 * queueing, which is why the rest of Pi's global surface is left alone.
 */
const piSettingsSchema = z.object({
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  defaultThinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable(),
  enabledModels: z.array(z.string()),
  compaction: z.object({
    enabled: nullableFlag,
    reserveTokens: nullableCount,
    keepRecentTokens: nullableCount,
  }).strict(),
  httpIdleTimeoutMs: nullableCount,
  shell: z.object({
    shellPath: z.string().nullable(),
    shellCommandPrefix: z.string().nullable(),
  }).strict(),
  telemetry: z.object({
    enableInstallTelemetry: nullableFlag,
    enableAnalytics: nullableFlag,
  }).strict(),
}).strict();

const updateSchema = z.object({ target: z.enum(["models", "plugins", "pinned"]) }).strict();

const usageSourceSchema = z.object({
  id: z.enum(["codex", "opencode-go", "ollama-cloud"]),
  label: z.string(),
  status: z.enum(["ok", "not_configured", "expired", "error"]),
  message: z.string().nullable(),
  windows: z.array(usageWindowSchema),
}).strict();

export const piExtrasHostContract = defineRpcContract({
  readUsage: {
    input: z.object({}).strict(),
    output: z.object({ sources: z.array(usageSourceSchema) }).strict(),
  },
  readSettings: { input: z.object({}).strict(), output: piSettingsSchema },
  writeSettings: { input: piSettingsSchema, output: piSettingsSchema },
  update: { input: updateSchema, output: z.object({ ok: z.boolean(), output: z.string() }).strict() },
  listModels: { input: z.object({}).strict(), output: modelListSchema },
});

export const piExtrasRpcContract = defineRpcContract({
  refreshUsage: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: z.object({
      hostName: z.string().nullable(),
      sources: z.array(usageSourceSchema),
    }).strict(),
  },
  readSettings: { input: z.object({}).strict(), output: piSettingsSchema },
  writeSettings: { input: piSettingsSchema, output: piSettingsSchema },
  update: { input: updateSchema, output: z.object({ ok: z.boolean(), output: z.string() }).strict() },
  listModels: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: modelListSchema,
  },
});

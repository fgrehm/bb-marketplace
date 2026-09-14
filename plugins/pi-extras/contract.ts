import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable(),
}).strict();

const piSettingsSchema = z.object({
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  defaultThinkingLevel: z.enum(["minimal", "low", "medium", "high"]).nullable(),
  enabledModels: z.array(z.string()),
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
});

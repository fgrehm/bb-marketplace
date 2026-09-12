import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const piSettingsSchema = z.object({
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  defaultThinkingLevel: z.enum(["minimal", "low", "medium", "high"]).nullable(),
  enabledModels: z.array(z.string()),
}).strict();

export const piSettingsHostContract = defineRpcContract({
  readSettings: { input: z.object({}).strict(), output: piSettingsSchema },
  writeSettings: { input: piSettingsSchema, output: piSettingsSchema },
  update: { input: z.object({ target: z.enum(["models", "plugins"]) }).strict(), output: z.object({ output: z.string() }).strict() },
});

export const piSettingsRpcContract = defineRpcContract({
  readSettings: { input: z.object({}).strict(), output: piSettingsSchema },
  writeSettings: { input: piSettingsSchema, output: piSettingsSchema },
  update: { input: z.object({ target: z.enum(["models", "plugins"]) }).strict(), output: z.object({ output: z.string() }).strict() },
});

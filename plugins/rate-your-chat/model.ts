import { z } from "zod";

export const USE_CASES = [
  "coding",
  "debugging",
  "review",
  "research",
  "planning",
  "writing",
  "other",
] as const;
export const SCORE_LABELS = [
  "Not useful",
  "Slightly useful",
  "Somewhat useful",
  "Useful",
  "Very useful",
] as const;
export const observationSchema = z.object({
  seq: z.number().int().positive(),
  at: z.number(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  evidence: z.enum(["requested", "legacy-request", "provider-fallback"]),
  requestId: z.string().nullable(),
  originalModel: z.string().nullable(),
  rejected: z.boolean(),
});
export type Observation = z.infer<typeof observationSchema>;
export const historySchema = z.object({
  capturedAt: z.number(),
  throughSeq: z.number().int().nonnegative(),
  status: z.enum(["recorded", "partial"]),
  warnings: z.array(z.string()),
  observations: z.array(observationSchema),
});
export type History = z.infer<typeof historySchema>;
export const ratingSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  title: z.string(),
  providerId: z.string(),
  score: z.number().int().min(1).max(5),
  useCase: z.enum(USE_CASES),
  note: z.string().max(4000),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number(),
  revision: z.number().int().positive(),
  history: historySchema,
});
export type Rating = z.infer<typeof ratingSchema>;
export const promptSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  archivedAt: z.number(),
});
export type Prompt = z.infer<typeof promptSchema>;

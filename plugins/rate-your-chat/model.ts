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
export type UseCase = (typeof USE_CASES)[number];
export const useCaseSchema = z.enum(USE_CASES);
export const useCasesSchema = z
  .array(useCaseSchema)
  .min(1, "Choose at least one purpose.")
  .max(USE_CASES.length)
  .refine(
    (values) => new Set(values).size === values.length,
    "Choose each purpose once.",
  );
export const useCaseLabel = (value: UseCase) =>
  value.charAt(0).toUpperCase() + value.slice(1);
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
  useCases: useCasesSchema,
  note: z.string().max(4000),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number(),
  revision: z.number().int().positive(),
  history: historySchema,
});
export type Rating = z.infer<typeof ratingSchema>;

// Older records stored one `useCase` string. Normalize them in memory so the
// rest of the plugin only handles `useCases`.
export function normalizeStoredRating(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("useCase" in value) ||
    "useCases" in value
  )
    return value;
  const { useCase, ...rest } = value as Record<string, unknown>;
  const parsed = useCaseSchema.safeParse(useCase);
  return { ...rest, useCases: [parsed.success ? parsed.data : "other"] };
}
export const promptSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  archivedAt: z.number(),
});
export type Prompt = z.infer<typeof promptSchema>;

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const identityInput = z.object({
  messageId: z.string().min(1).max(512),
  threadId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128),
});

const unavailable = z.object({
  status: z.literal("unavailable"),
  reason: z.enum(["missing_environment", "not_ready", "not_workspace"]),
});
const invalidRound = z.object({ status: z.literal("invalid_round") });
const storageError = z.object({
  status: z.literal("storage_error"),
  reason: z.enum(["read_failed", "write_failed", "corrupt"]),
});

export const rpcContract = defineRpcContract({
  lazy_reply_eligible: {
    input: identityInput,
    output: z.object({ eligible: z.boolean() }),
  },
  lazy_reply_load: {
    input: identityInput,
    output: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("loaded"),
        contributionBody: z.string().max(1_000_000),
        draftBody: z.string().max(1_000_000).nullable(),
        draftSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
      }),
      invalidRound,
      unavailable,
      storageError,
    ]),
  },
  lazy_reply_save: {
    input: identityInput.extend({
      body: z.string().max(1_000_000),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .nullable(),
    }),
    output: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("saved"),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
      z.object({
        status: z.literal("conflict"),
        diskBody: z.string().max(1_000_000).nullable(),
        diskSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
      }),
      invalidRound,
      unavailable,
      storageError,
    ]),
  },
});

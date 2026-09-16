import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const answersSchema = z.object({
  interests: z.array(z.string().max(80)).max(20),
  research: z.array(z.string().max(80)).max(20),
  missList: z.array(z.string().max(80)).max(20),
  savedMeaning: z.string().max(120),
  autonomy: z.string().max(120),
}).strict();

const profileSchema = z.object({
  answers: answersSchema,
  acceptedDrafts: z.array(z.string().max(80)).max(20),
  notebook: z.string().max(20_000),
  completedAt: z.number().int().nonnegative(),
}).strict();

export type LibrarianProfile = z.infer<typeof profileSchema>;

export const rpcContract = defineRpcContract({
  onboarding_get: {
    input: z.object({}).strict(),
    output: z.object({ profile: profileSchema.nullable() }).strict(),
  },
  onboarding_save: {
    input: profileSchema,
    output: z.object({ saved: z.literal(true) }).strict(),
  },
  notebook_save: {
    input: z.object({ notebook: z.string().max(20_000) }).strict(),
    output: z.object({ saved: z.boolean() }).strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    async onboarding_get() {
      const profile = await bb.storage.kv.get<LibrarianProfile>("librarian-profile");
      return { profile: profile ?? null };
    },
    async onboarding_save(profile) {
      await bb.storage.kv.set("librarian-profile", profile);
      return { saved: true as const };
    },
    async notebook_save({ notebook }) {
      const profile = await bb.storage.kv.get<LibrarianProfile>("librarian-profile");
      if (!profile) return { saved: false };
      await bb.storage.kv.set("librarian-profile", { ...profile, notebook });
      return { saved: true };
    },
  });

  bb.log.info("JOMO loaded with the librarian interview and fake feed data");
}

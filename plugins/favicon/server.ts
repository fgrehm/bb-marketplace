import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  upload: {
    input: z.object({
      variant: z.enum(["light", "dark"]),
      data: z.string().max(350_000),
    }).strict(),
    output: z.object({ stored: z.boolean() }),
  },
  get: {
    input: z.object({ variant: z.enum(["light", "dark"]) }).strict(),
    output: z.object({ data: z.string().nullable() }).strict(),
  },
  remove: {
    input: z.object({ variant: z.enum(["light", "dark"]) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    async upload({ variant, data }) {
      await bb.storage.kv.set(`uploaded-${variant}`, { data });
      return { stored: true };
    },
    async get({ variant }) {
      const uploaded = await bb.storage.kv.get<{ data: string }>(`uploaded-${variant}`);
      return { data: uploaded?.data ?? null };
    },
    async remove({ variant }) {
      await bb.storage.kv.delete(`uploaded-${variant}`);
      return { removed: true };
    },
  });

  // Uploads are the only artwork source, and only SVG is accepted: it scales
  // cleanly to the 16px and 32px favicon links and the client applies the
  // favicon-color tint on top.
  bb.http.route("GET", "/favicon", async (context) => {
    const variant = context.req.query("variant") === "dark" ? "dark" : "light";
    const uploaded = await bb.storage.kv.get<{ data: string }>(`uploaded-${variant}`);
    if (!uploaded) return new Response("No favicon configured", { status: 404 });
    return new Response(Buffer.from(uploaded.data, "base64"), {
      headers: { "content-type": "image/svg+xml", "cache-control": "no-cache" },
    });
  });
}

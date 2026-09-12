import { type BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * The PoC deliberately has no network or persistence layer. Keeping a real
 * server entry makes the package installable and leaves a clear seam for RSS,
 * Readability, and BB thread actions once the interaction is proven.
 */
export default async function plugin(bb: BbPluginApi) {
  bb.log.info("Flux loaded with fake feed data");
}

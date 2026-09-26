import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { piExtrasHostContract, piExtrasRpcContract } from "./contract.js";
import { unavailablePiUsage } from "./usage.js";
import usagePagePlugin from "./usage-page/server.js";

export default function plugin(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: piExtrasHostContract });

  let cachedUsage: {
    fetchedAt: number;
    result: Awaited<ReturnType<typeof fetchUsage>>;
  } | null = null;
  const CACHE_TTL_MS = 60_000;

  let cachedModels: {
    fetchedAt: number;
    result: Awaited<ReturnType<typeof fetchModels>>;
  } | null = null;

  async function fetchModels() {
    const hostId = (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) throw new Error("No primary BB machine is configured.");
    return host.call("listModels", {}, { hostId, signal: AbortSignal.timeout(40_000) });
  }

  async function fetchUsage() {
    let hostId: string | null;
    try {
      hostId = (await bb.sdk.system.config()).primaryHostId;
    } catch {
      return { hostName: null, ...unavailablePiUsage("Unable to identify the primary BB machine.") };
    }
    if (hostId === null) {
      return { hostName: null, ...unavailablePiUsage("No primary BB machine is configured.") };
    }
    try {
      const usage = await host.call("readUsage", {}, {
        hostId,
        signal: AbortSignal.timeout(20_000),
      });
      const hosts = await bb.sdk.hosts.list().catch(() => []);
      const selectedHost = hosts.find((candidate) => candidate.id === hostId);
      return { hostName: selectedHost?.name ?? null, ...usage };
    } catch {
      return { hostName: null, ...unavailablePiUsage("Unable to load usage from the primary BB machine.") };
    }
  }

  bb.rpc.register(piExtrasRpcContract, {
    async readSettings() {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) throw new Error("No primary BB machine is configured.");
      return host.call("readSettings", {}, { hostId });
    },
    async writeSettings(input) {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) throw new Error("No primary BB machine is configured.");
      return host.call("writeSettings", input, { hostId });
    },
    async update(input) {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) throw new Error("No primary BB machine is configured.");
      const result = await host.call("update", input, { hostId, signal: AbortSignal.timeout(130_000) });
      // A catalog refresh changes which models exist, so the cached list is stale.
      if (input.target === "models") cachedModels = null;
      return result;
    },
    async listModels(input) {
      const force = input?.force === true;
      if (!force && cachedModels !== null && Date.now() - cachedModels.fetchedAt < CACHE_TTL_MS) {
        return cachedModels.result;
      }
      const result = await fetchModels();
      cachedModels = { fetchedAt: Date.now(), result };
      return result;
    },
    async refreshUsage(input) {
      const force = input?.force === true;
      if (
        !force &&
        cachedUsage !== null &&
        Date.now() - cachedUsage.fetchedAt < CACHE_TTL_MS
      ) {
        return cachedUsage.result;
      }
      const result = await fetchUsage();
      // Only cache successes; errors are cheap to retry.
      if (result.sources.some((source) => source.status !== "error")) {
        cachedUsage = { fetchedAt: Date.now(), result };
      }
      return result;
    },
  });

  usagePagePlugin(bb);
}

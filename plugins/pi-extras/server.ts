import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { piExtrasHostContract, piExtrasRpcContract } from "./contract.js";
import { unavailablePiUsage } from "./usage.js";
import usagePagePlugin from "./usage-page/server.js";

import { isCommitPrompt } from "./pi-title.js";

const TITLE_STATUS_TTL_MS = 30_000;

export default function plugin(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: piExtrasHostContract });

  /**
   * Both text models live in plugin storage rather than `bb.settings.define`,
   * which BB renders as its own plain text inputs and would duplicate the
   * pickers below.
   */
  const readTextSettings = async (): Promise<{ titleModel: string; commitModel: string }> => {
    const [titleModel, commitModel] = await Promise.all([
      bb.storage.kv.get<string>("titleModel"),
      bb.storage.kv.get<string>("commitModel"),
    ]);
    return { titleModel: titleModel ?? "", commitModel: commitModel ?? "" };
  };

  let titleStatus: { fetchedAt: number; result: { ready: true } } | null = null;

  // Shared by BB's service picker and the Pi settings panel.
  async function probeTitleService(): Promise<{ ready: true } | { ready: false; message: string }> {
    try {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) return { ready: false, message: "No primary BB machine is configured." };
      if (titleStatus && Date.now() - titleStatus.fetchedAt < TITLE_STATUS_TTL_MS) return titleStatus.result;
      const result = await host.call("probeTitleService", {}, { hostId });
      if (result.ready) titleStatus = { fetchedAt: Date.now(), result };
      return result;
    } catch (error) {
      return { ready: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  const titleService = bb.experimental_aiServices.register({
    id: "pi",
    displayName: "Pi",
    async complete(prompt, { signal }) {
      // BB offers one `complete` for both tasks and passes no task id, so the
      // prompt decides which model to use. A commit prompt is long, and a slow
      // model misses BB's five-second budget, so the commit model is
      // configurable and falls back to the title model.
      const commit = isCommitPrompt(prompt);
      const { titleModel, commitModel } = await readTextSettings();
      const model = (commit ? commitModel || titleModel : titleModel).trim() || null;
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) throw new Error("No primary BB machine is configured.");
      const result = await host.call(
        "generateText",
        { prompt, model },
        { hostId, signal },
      );
      // Text mode does not report which model answered, so log the request.
      bb.log.info(
        `${commit ? "commit message" : "thread title"} generated with ${model ?? "pi's default model"}`,
      );
      return result.text;
    },
    status: probeTitleService,
  });

  bb.onDispose(() => titleService.dispose());

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
    async titleServiceStatus() {
      return probeTitleService();
    },
    async readTitleSettings() {
      return readTextSettings();
    },
    async writeTitleSettings(input) {
      await Promise.all([
        bb.storage.kv.set("titleModel", input.titleModel),
        bb.storage.kv.set("commitModel", input.commitModel),
      ]);
      return { titleModel: input.titleModel, commitModel: input.commitModel };
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

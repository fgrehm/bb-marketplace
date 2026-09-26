import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { piExtrasHostContract } from "./contract.js";
import { readPiUsage } from "./usage.js";
import { readSettings, runPiUpdate, writeSettings } from "./pi-settings.js";
import { listAvailableModels } from "./pi-models.js";

export default experimental_defineHostEntry({
  contract: piExtrasHostContract,
  handlers: {
    readUsage: async () => readPiUsage(),
    readSettings: async () => readSettings(),
    writeSettings: async (next) => writeSettings(next),
    update: async ({ target }) => runPiUpdate(target),
    listModels: async () => listAvailableModels(),
  },
});

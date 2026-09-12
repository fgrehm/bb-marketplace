import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { piSettingsHostContract } from "./contract.js";
import { readSettings, runPiUpdate, writeSettings } from "./settings.js";

export default experimental_defineHostEntry({
  contract: piSettingsHostContract,
  handlers: {
    readSettings: async () => readSettings(),
    writeSettings: async (next) => writeSettings(next),
    update: async ({ target }) => ({ output: await runPiUpdate(target) }),
  },
});

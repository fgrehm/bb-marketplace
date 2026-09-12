import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { piExtrasHostContract } from "./contract.js";
import { readPiUsage } from "./usage.js";

export default experimental_defineHostEntry({
  contract: piExtrasHostContract,
  handlers: {
    readUsage: async () => readPiUsage(),
  },
});

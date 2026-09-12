import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { piSettingsHostContract, piSettingsRpcContract } from "./contract.js";

export default function plugin(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: piSettingsHostContract });
  bb.rpc.register(piSettingsRpcContract, {
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
      return host.call("update", input, { hostId, signal: AbortSignal.timeout(130_000) });
    },
  });
}

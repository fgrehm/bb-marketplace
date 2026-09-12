import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { piExtrasHostContract } from "./contract.js";
import { readPiUsage } from "./usage.js";

const execFileAsync = promisify(execFile);
const settingsPath = () => join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? process.cwd(), ".pi", "agent"), "settings.json");
const readSettings = async () => {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(await readFile(settingsPath(), "utf8")) as Record<string, unknown>; } catch {}
  return {
    defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : null,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : null,
    defaultThinkingLevel: ["minimal", "low", "medium", "high"].includes(String(raw.defaultThinkingLevel)) ? raw.defaultThinkingLevel as "minimal" | "low" | "medium" | "high" : null,
    enabledModels: Array.isArray(raw.enabledModels) ? raw.enabledModels.filter((value): value is string => typeof value === "string") : [],
  };
};

export default experimental_defineHostEntry({
  contract: piExtrasHostContract,
  handlers: {
    readUsage: async () => readPiUsage(),
    readSettings,
    writeSettings: async (next) => {
      const path = settingsPath();
      let current: Record<string, unknown> = {};
      try { current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; } catch {}
      const updated = { ...current };
      for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"] as const) {
        if (next[key] === null || (key === "enabledModels" && next[key].length === 0)) delete updated[key];
        else updated[key] = next[key];
      }
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.tmp-${process.pid}`;
      await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      await rename(temp, path);
      return next;
    },
    update: async ({ target }) => {
      const args = target === "models" ? ["update", "--models"] : ["update", "--extensions"];
      const result = await execFileAsync("pi", args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      return { output: `${result.stdout}${result.stderr}`.trim() };
    },
  },
});

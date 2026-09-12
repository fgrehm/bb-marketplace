import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type PiSettings = {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: "minimal" | "low" | "medium" | "high" | null;
  enabledModels: string[];
};

const execFileAsync = promisify(execFile);
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? process.cwd(), ".pi", "agent"), "settings.json");
}

export async function readSettings(env = process.env): Promise<PiSettings> {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(await readFile(settingsPath(env), "utf8")) as Record<string, unknown>; } catch {}
  return {
    defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : null,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : null,
    defaultThinkingLevel: ["minimal", "low", "medium", "high"].includes(String(raw.defaultThinkingLevel)) ? raw.defaultThinkingLevel as PiSettings["defaultThinkingLevel"] : null,
    enabledModels: Array.isArray(raw.enabledModels) ? raw.enabledModels.filter((value): value is string => typeof value === "string") : [],
  };
}

export async function writeSettings(next: PiSettings, env = process.env): Promise<PiSettings> {
  const path = settingsPath(env);
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
}

export async function runPiUpdate(target: "models" | "plugins", env = process.env): Promise<string> {
  const args = target === "models" ? ["update", "--models"] : ["update", "--extensions"];
  const result = await execFileAsync("pi", args, { env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  return `${result.stdout}${result.stderr}`.trim();
}

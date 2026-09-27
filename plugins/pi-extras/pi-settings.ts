import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ThinkingLevel } from "./model-scope.js";

/** The levels pi accepts for `defaultThinkingLevel`. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

export type PiSettings = {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: ThinkingLevel | null;
  enabledModels: string[];
  compaction: { enabled: boolean | null; reserveTokens: number | null; keepRecentTokens: number | null };
  httpIdleTimeoutMs: number | null;
  shell: { shellPath: string | null; shellCommandPrefix: string | null };
  telemetry: { enableInstallTelemetry: boolean | null; enableAnalytics: boolean | null };
};

type JsonRecord = Record<string, unknown>;

/** Every setting unset, which is what Pi reads when a key is absent. */
export function unsetPiSettings(overrides: Partial<PiSettings> = {}): PiSettings {
  return {
    defaultProvider: null,
    defaultModel: null,
    defaultThinkingLevel: null,
    enabledModels: [],
    compaction: { enabled: null, reserveTokens: null, keepRecentTokens: null },
    httpIdleTimeoutMs: null,
    shell: { shellPath: null, shellCommandPrefix: null },
    telemetry: { enableInstallTelemetry: null, enableAnalytics: null },
    ...overrides,
  };
}

/** Where each setting lives in settings.json. A null value deletes the key. */
const PATHS = {
  compactionEnabled: "compaction.enabled",
  compactionReserveTokens: "compaction.reserveTokens",
  compactionKeepRecentTokens: "compaction.keepRecentTokens",
  httpIdleTimeoutMs: "httpIdleTimeoutMs",
  shellPath: "shellPath",
  shellCommandPrefix: "shellCommandPrefix",
  enableInstallTelemetry: "enableInstallTelemetry",
  enableAnalytics: "enableAnalytics",
} as const;

/** Nested groups the panel owns; only these are pruned when they end up empty. */
const MANAGED_GROUPS = ["compaction"] as const;

function leaf(raw: JsonRecord, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (value, key) => (typeof value === "object" && value !== null ? (value as JsonRecord)[key] : undefined),
    raw,
  );
}

function setLeaf(target: JsonRecord, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (next === undefined && value === undefined) return;
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      if (value === undefined) return;
      node[key] = {};
    }
    node = node[key] as JsonRecord;
  }
  const last = keys[keys.length - 1]!;
  if (value === undefined) delete node[last];
  else node[last] = value;
}

/** Drops a managed group left empty by removals, so an unset group disappears. */
function pruneEmptyGroups(target: JsonRecord, roots: readonly string[]): void {
  for (const key of roots) {
    const value = target[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    if (Object.keys(value).length === 0) delete target[key];
  }
}

function asFlag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}


const execFileAsync = promisify(execFile);
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? process.cwd(), ".pi", "agent"), "settings.json");
}

export async function readSettings(env = process.env): Promise<PiSettings> {
  let raw: JsonRecord = {};
  try { raw = JSON.parse(await readFile(settingsPath(env), "utf8")) as JsonRecord; } catch {}
  return {
    defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : null,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : null,
    defaultThinkingLevel: (THINKING_LEVELS as readonly string[]).includes(String(raw.defaultThinkingLevel)) ? raw.defaultThinkingLevel as PiSettings["defaultThinkingLevel"] : null,
    enabledModels: Array.isArray(raw.enabledModels) ? raw.enabledModels.filter((value): value is string => typeof value === "string") : [],
    compaction: {
      enabled: asFlag(leaf(raw, PATHS.compactionEnabled)),
      reserveTokens: asCount(leaf(raw, PATHS.compactionReserveTokens)),
      keepRecentTokens: asCount(leaf(raw, PATHS.compactionKeepRecentTokens)),
    },
    httpIdleTimeoutMs: asCount(leaf(raw, PATHS.httpIdleTimeoutMs)),
    shell: {
      shellPath: typeof raw.shellPath === "string" ? raw.shellPath : null,
      shellCommandPrefix: typeof raw.shellCommandPrefix === "string" ? raw.shellCommandPrefix : null,
    },
    telemetry: {
      enableInstallTelemetry: asFlag(leaf(raw, PATHS.enableInstallTelemetry)),
      enableAnalytics: asFlag(leaf(raw, PATHS.enableAnalytics)),
    },
  };
}

export async function writeSettings(next: PiSettings, env = process.env): Promise<PiSettings> {
  const path = settingsPath(env);
  let current: JsonRecord = {};
  try { current = JSON.parse(await readFile(path, "utf8")) as JsonRecord; } catch {}
  const updated: JsonRecord = { ...current };
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"] as const) {
    if (next[key] === null || (key === "enabledModels" && next[key].length === 0)) delete updated[key];
    else updated[key] = next[key];
  }

  // A null value removes the key so pi applies its own default.
  const write = (path: string, value: string | number | boolean | null) =>
    setLeaf(updated, path, value ?? undefined);

  write(PATHS.compactionEnabled, next.compaction.enabled);
  write(PATHS.compactionReserveTokens, next.compaction.reserveTokens);
  write(PATHS.compactionKeepRecentTokens, next.compaction.keepRecentTokens);
  write(PATHS.httpIdleTimeoutMs, next.httpIdleTimeoutMs);
  write(PATHS.shellPath, next.shell.shellPath);
  write(PATHS.shellCommandPrefix, next.shell.shellCommandPrefix);
  write(PATHS.enableInstallTelemetry, next.telemetry.enableInstallTelemetry);
  write(PATHS.enableAnalytics, next.telemetry.enableAnalytics);
  pruneEmptyGroups(updated, MANAGED_GROUPS);

  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await rename(temp, path);
  return next;
}

const PINNED_NPM_SOURCE = /^npm:(@[^/]+\/[^@]+|[^@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function unpinNpmPackages(packages: unknown[]): { packages: unknown[]; names: string[] } {
  const names: string[] = [];
  const updated = packages.map((entry) => {
    const source = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source : null;
    const match = source?.match(PINNED_NPM_SOURCE);
    if (!match) return entry;
    names.push(match[1]!);
    const replacement = `npm:${match[1]}`;
    return typeof entry === "string" ? replacement : { ...(entry as Record<string, unknown>), source: replacement };
  });
  return { packages: updated, names };
}

async function updatePinnedPackages(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  const path = settingsPath(env);
  let original: Record<string, unknown>;
  try {
    original = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, output: `Unable to read Pi settings: ${error instanceof Error ? error.message : String(error)}` };
  }
  const currentPackages = Array.isArray(original.packages) ? original.packages : [];
  const unpinned = unpinNpmPackages(currentPackages);
  if (unpinned.names.length === 0) return { ok: true, output: "No pinned npm packages found." };
  const versions = new Map<string, string>();
  try {
    for (const name of unpinned.names) {
      const result = await execFileAsync("npm", ["view", name, "version", "--json"], { env, timeout: 30_000 });
      const version = JSON.parse(result.stdout) as unknown;
      if (typeof version !== "string") throw new Error(`npm returned no version for ${name}`);
      versions.set(name, version);
    }
    await writeRawSettings({ ...original, packages: unpinned.packages }, env);
    const updated = await runPiUpdate("plugins", env);
    if (!updated.ok) {
      await writeRawSettings(original, env);
      return updated;
    }
    const repinned = unpinned.packages.map((entry) => {
      const source = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null ? (entry as { source?: unknown }).source : null;
      if (typeof source !== "string" || !source.startsWith("npm:")) return entry;
      const name = source.slice(4);
      const version = versions.get(name);
      if (!version) return entry;
      const replacement = `${source}@${version}`;
      return typeof entry === "string" ? replacement : { ...(entry as Record<string, unknown>), source: replacement };
    });
    await writeRawSettings({ ...original, packages: repinned }, env);
    return { ok: true, output: `${updated.output}\n\nUpdated pins:\n${unpinned.names.map((name) => `  ${name}@${versions.get(name)}`).join("\n")}`.trim() };
  } catch (error) {
    await writeRawSettings(original, env).catch(() => undefined);
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

async function writeRawSettings(value: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<void> {
  const path = settingsPath(env);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export async function runPiUpdate(
  target: "models" | "plugins" | "pinned",
  env = process.env,
): Promise<{ ok: boolean; output: string }> {
  if (target === "pinned") return updatePinnedPackages(env);
  const args = target === "models" ? ["update", "--models"] : ["update", "--extensions"];
  try {
    const result = await execFileAsync("pi", args, { env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
    return { ok: false, output: output || failure.message };
  }
}

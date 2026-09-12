import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageStatus = "ok" | "not_configured" | "expired" | "error";

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface UsageSource {
  id: "codex" | "opencode-go" | "ollama-cloud";
  label: string;
  status: UsageStatus;
  message: string | null;
  windows: UsageWindow[];
}

export interface PiUsageSnapshot {
  sources: UsageSource[];
}

type JsonRecord = Record<string, unknown>;
type FetchResponse = Pick<Response, "ok" | "status" | "json">;
type Fetcher = (input: string, init?: RequestInit) => Promise<FetchResponse>;
type ReadFile = (path: string, encoding: BufferEncoding) => Promise<string>;

interface Credentials {
  codex: { access: string; accountId: string } | null;
  opencodeGo: string | null;
  ollamaCloud: string | null;
}

export interface UsageReaderDependencies {
  fetch?: Fetcher;
  readFile?: ReadFile;
  authPath?: string;
}

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function boundedPercent(value: unknown): number | null {
  const number = numberValue(value);
  if (number === null || number < 0 || number > 100) return null;
  return Math.round(number);
}

function resetTime(value: unknown): string | null {
  const raw = stringValue(value);
  if (raw === null || Number.isNaN(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function unixResetTime(value: unknown): string | null {
  const seconds = numberValue(value);
  if (seconds === null || seconds <= 0) return null;
  return new Date(seconds * 1_000).toISOString();
}

function authFilePath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
}

export function parseCredentials(payload: unknown): Credentials {
  const root = asRecord(payload);
  const codexEntry = asRecord(root?.["openai-codex"]);
  const codexAccess = stringValue(codexEntry?.access);
  const codexAccountId = stringValue(codexEntry?.accountId);
  const openCodeEntry = asRecord(root?.["opencode-go"]);
  const ollamaEntry = asRecord(root?.["ollama-cloud"]);

  return {
    codex: codexAccess !== null && codexAccountId !== null
      ? { access: codexAccess, accountId: codexAccountId }
      : null,
    opencodeGo: stringValue(openCodeEntry?.key),
    ollamaCloud: stringValue(ollamaEntry?.key),
  };
}

export function parseCodexUsage(payload: unknown): UsageWindow[] | null {
  const rateLimit = asRecord(asRecord(payload)?.rate_limit);
  if (rateLimit === null) return null;
  const windows: UsageWindow[] = [];
  for (const [key, label] of [["primary_window", "5 hours"], ["secondary_window", "Weekly"]] as const) {
    const window = asRecord(rateLimit[key]);
    const usedPercent = boundedPercent(window?.used_percent);
    if (usedPercent !== null) {
      windows.push({ label, usedPercent, resetsAt: unixResetTime(window?.reset_at) });
    }
  }
  return windows.length === 0 ? null : windows;
}

export function parseOpenCodeGoUsage(payload: unknown): UsageWindow[] | null {
  const usage = asRecord(asRecord(payload)?.usage);
  if (usage === null) return null;
  const windows: UsageWindow[] = [];
  for (const [key, label] of [["rolling", "5 hours"], ["weekly", "Weekly"], ["monthly", "Monthly"]] as const) {
    const window = asRecord(usage[key]);
    const usedPercent = boundedPercent(window?.percent);
    if (usedPercent !== null) {
      windows.push({ label, usedPercent, resetsAt: resetTime(window?.resetsAt) });
    }
  }
  return windows.length === 0 ? null : windows;
}

export function parseOllamaUsage(payload: unknown): UsageWindow[] | null {
  const monthly = asRecord(asRecord(payload)?.limits)?.monthly;
  const usage = numberValue(asRecord(monthly)?.usage);
  if (usage === null || usage < 0 || usage > 1) return null;
  // Ollama's API exposes no quota reset time. Its activity.period is a
  // rolling "last 4 weeks" window (ending_at ≈ now), not a reset date, so
  // resetsAt stays null rather than showing a bogus "resets now".
  return [{ label: "Monthly (30d)", usedPercent: Math.round(usage * 100), resetsAt: null }];
}

const SOURCES = [
  { id: "codex" as const, label: "Codex" },
  { id: "opencode-go" as const, label: "OpenCode Go" },
  { id: "ollama-cloud" as const, label: "Ollama Cloud" },
];

function unconfigured(id: UsageSource["id"], label: string): UsageSource {
  return { id, label, status: "not_configured", message: "No credential is configured.", windows: [] };
}

function errorSource(id: UsageSource["id"], label: string, message: string): UsageSource {
  return { id, label, status: "error", message, windows: [] };
}

export function unavailablePiUsage(message: string): PiUsageSnapshot {
  return { sources: SOURCES.map(({ id, label }) => errorSource(id, label, message)) };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function fetchSource(
  id: UsageSource["id"],
  label: string,
  url: string,
  token: string,
  parse: (payload: unknown) => UsageWindow[] | null,
  fetcher: Fetcher,
  headers: Record<string, string> = {},
): Promise<UsageSource> {
  try {
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      return { id, label, status: "expired", message: "The credential was rejected. Refresh it in Pi.", windows: [] };
    }
    if (!response.ok) return errorSource(id, label, `Usage service returned HTTP ${response.status}.`);
    const windows = parse(await response.json());
    return windows === null
      ? errorSource(id, label, "Usage service returned an unexpected response.")
      : { id, label, status: "ok", message: null, windows };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return errorSource(id, label, "Usage service returned invalid JSON.");
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      return errorSource(id, label, "Usage request timed out.");
    }
    return errorSource(id, label, "Unable to load usage.");
  }
}

export async function readPiUsage(deps: UsageReaderDependencies = {}): Promise<PiUsageSnapshot> {
  const read = deps.readFile ?? readFile;
  const fetcher = deps.fetch ?? fetch;
  let credentials: Credentials;
  try {
    credentials = parseCredentials(JSON.parse(await read(deps.authPath ?? authFilePath(), "utf8")));
  } catch (error) {
    if (!isMissingFile(error)) {
      return unavailablePiUsage("Unable to read credentials.");
    }
    credentials = { codex: null, opencodeGo: null, ollamaCloud: null };
  }

  const codex = credentials.codex === null
    ? Promise.resolve(unconfigured("codex", "Codex"))
    : fetchSource("codex", "Codex", CODEX_USAGE_URL, credentials.codex.access, parseCodexUsage, fetcher, {
      "ChatGPT-Account-Id": credentials.codex.accountId,
      "User-Agent": "pi-extras-bb-plugin",
    });
  const opencodeGo = credentials.opencodeGo === null
    ? Promise.resolve(unconfigured("opencode-go", "OpenCode Go"))
    : fetchSource("opencode-go", "OpenCode Go", OPENCODE_GO_USAGE_URL, credentials.opencodeGo, parseOpenCodeGoUsage, fetcher);
  const ollamaCloud = credentials.ollamaCloud === null
    ? Promise.resolve(unconfigured("ollama-cloud", "Ollama Cloud"))
    : fetchSource("ollama-cloud", "Ollama Cloud", OLLAMA_USAGE_URL, credentials.ollamaCloud, parseOllamaUsage, fetcher, {
      "User-Agent": "undici",
    });

  return { sources: await Promise.all([codex, opencodeGo, ollamaCloud]) };
}

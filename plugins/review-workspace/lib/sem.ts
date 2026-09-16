// EXPERIMENTAL: entity-level diff via the `sem` CLI (@ataraxy-labs/sem).
// Isolated from the main review flow - callers must degrade gracefully when
// the binary is unavailable.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { stableEntityId } from "./sem-outline";

export type SemEntityChange = {
  entityId: string;
  changeType:
    "added" | "modified" | "deleted" | "moved" | "renamed" | "reordered";
  entityType: string;
  entityName: string;
  startLine: number | null;
  endLine: number | null;
  oldStartLine: number | null;
  oldEndLine: number | null;
  filePath: string;
  structuralChange: boolean | null;
  // Present when sem includes per-entity content and it fits the cap; large
  // entities ship as null so the outline can say "too large to inline".
  beforeContent?: string | null;
  afterContent?: string | null;
};

export type SemDiffInput = {
  filePath: string;
  beforeContent: string | null;
  afterContent: string | null;
};

export type SemDiffResult =
  | { status: "ok"; changes: SemEntityChange[] }
  | { status: "unavailable"; reason: string };

export function buildSemStdinPayload(inputs: SemDiffInput[]): string {
  return JSON.stringify(
    inputs.map((input) => ({
      filePath: input.filePath,
      status:
        input.beforeContent != null && input.afterContent != null
          ? "modified"
          : input.beforeContent != null
            ? "deleted"
            : "added",
      beforeContent: input.beforeContent ?? undefined,
      afterContent: input.afterContent ?? undefined,
    })),
  );
}

// The CLI prefixes stderr-ish telemetry notices on stdout in some versions,
// so slice from the first "{" defensively.
export function parseSemJson(raw: string): {
  changes: SemEntityChange[];
} {
  const start = raw.indexOf("{");
  const parsed = JSON.parse(start === -1 ? raw : raw.slice(start)) as {
    changes: Array<Record<string, unknown>>;
  };
  return {
    changes: (parsed.changes ?? []).map((change) => ({
      entityId: String(change.entityId ?? ""),
      changeType: ([
        "added",
        "modified",
        "deleted",
        "moved",
        "renamed",
        "reordered",
      ].includes(String(change.changeType))
        ? String(change.changeType)
        : "modified") as SemEntityChange["changeType"],
      entityType: String(change.entityType ?? "entity"),
      entityName: String(change.entityName ?? ""),
      startLine: change.startLine == null ? null : Number(change.startLine),
      endLine: change.endLine == null ? null : Number(change.endLine),
      oldStartLine:
        change.oldStartLine == null ? null : Number(change.oldStartLine),
      oldEndLine: change.oldEndLine == null ? null : Number(change.oldEndLine),
      filePath: String(change.filePath ?? ""),
      structuralChange:
        change.structuralChange == null
          ? null
          : Boolean(change.structuralChange),
      beforeContent: capContent(change.beforeContent),
      afterContent: capContent(change.afterContent),
    })),
  };
}

let cachedBinaryPath: string | null | undefined;

export function semBinaryPath(): string | null {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath;
  const override = process.env.SEM_BIN_PATH;
  if (override && existsSync(override)) {
    cachedBinaryPath = override;
    return override;
  }
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("@ataraxy-labs/sem/package.json");
    const vendored = path.join(path.dirname(packageJson), "vendor", "sem");
    cachedBinaryPath = existsSync(vendored) ? vendored : null;
  } catch {
    cachedBinaryPath = null;
  }
  return cachedBinaryPath;
}

// For tests: allow resetting the memoized path probe.
export function resetSemBinaryPath(): void {
  cachedBinaryPath = undefined;
}

function spawnSem(
  args: string[],
  stdin: string | null,
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const binary = semBinaryPath();
    if (!binary) {
      reject(new Error("sem binary not found"));
      return;
    }
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, SEM_NO_TELEMETRY: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `sem exited with code ${code}`));
    });
    if (stdin != null) {
      child.stdin.on("error", () => {
        /* ignore EPIPE while closing early */
      });
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

// Per-entity content caps: the entities view wants a quick view, not whole
// blobs. Shared with the server-side snapshot backfill.
export const ENTITY_CONTENT_MAX_CHARS = 8000;

function capContent(content: unknown): string | null {
  if (typeof content !== "string") return null;
  return content.length > ENTITY_CONTENT_MAX_CHARS ? null : content;
}

export type SemEntityBrief = {
  entityId: string;
  file: string;
  lines: [number, number];
  name: string;
  type: string;
};

function toBrief(item: Record<string, unknown>): SemEntityBrief {
  const lines = Array.isArray(item.lines)
    ? item.lines.map((value) => Number(value))
    : [];
  return {
    entityId: String(item.entityId ?? ""),
    file: String(item.file ?? ""),
    lines: [lines[0] ?? 0, lines[1] ?? 0],
    name: String(item.name ?? ""),
    type: String(item.type ?? "entity"),
  };
}

export type SemImpactResult =
  | {
      status: "ok";
      dependents: SemEntityBrief[];
      tests: SemEntityBrief[];
      total: number;
      depth: number;
      // Entity sem resolved the analysis for; set when it is an ancestor of
      // the clicked entity (properties/orphans are not individually indexed).
      resolvedAs: SemEntityBrief | null;
    }
  | { status: "unavailable"; reason: string };

export async function runEntityImpact(
  entityId: string,
  entityName: string,
  entityFile: string,
  repoRoot: string,
  entityType?: string,
): Promise<SemImpactResult> {
  // Orphan entities are module-level churn (imports, parsing fallbacks):
  // there is no named entity to run impact for, so say so instead of
  // "Entity '' not found".
  if (entityType === "orphan" || !entityName.trim()) {
    return {
      status: "unavailable",
      reason: "module-level change: no impact analysis",
    };
  }
  if (!semBinaryPath()) {
    return {
      status: "unavailable",
      reason:
        "sem binary not found (install sem-cli or add the optional @ataraxy-labs/sem dependency)",
    };
  }
  try {
    // sem diff emits granular ids (properties, orphan chunks) with a `@L<n>`
    // line suffix; stable ids drop it. sem impact --entity-id resolves the
    // raw suffixed id and uniquely-named stable ids; when two same-named
    // entities share a file the stable form is ambiguous, so try the raw id
    // first, then the stable id, then stable ancestors. Fall back to
    // name+file last. Candidate ids must keep the `path::type::name…`
    // shape: stripping down to a bare file path (or sem's `path::orphan`
    // intermediate) is never indexed, and would surface "Entity 'app.tsx'
    // not found" instead of a clean fallback.
    const rawId = entityId;
    const stable = stableEntityId(entityId);
    const candidates: string[] = [];
    if (rawId.split("::").length >= 3) candidates.push(rawId);
    if (stable !== rawId && stable.split("::").length >= 3)
      candidates.push(stable);
    let candidate = stable;
    for (let hops = 0; hops < 3; hops++) {
      const idx = candidate.lastIndexOf("::");
      if (idx <= 0) break;
      candidate = candidate.slice(0, idx);
      if (candidate.split("::").length >= 3) candidates.push(candidate);
    }
    let raw: string | null = null;
    for (const id of candidates) {
      try {
        raw = await spawnSem(
          ["impact", "--entity-id", id, "--json"],
          null,
          repoRoot,
        );
        break;
      } catch {
        /* try the next ancestor or the name fallback */
      }
    }
    if (raw == null) {
      raw = await spawnSem(
        ["impact", entityName, "--file", entityFile, "--json"],
        null,
        repoRoot,
      );
    }
    const start = raw.indexOf("{");
    const parsed = JSON.parse(start === -1 ? raw : raw.slice(start)) as {
      dependents?: Array<Record<string, unknown>>;
      tests?: Array<Record<string, unknown>>;
      impact?: { entities?: Array<Record<string, unknown>>; total?: number };
      entity?: Record<string, unknown>;
    };
    // The entity sem actually resolved (may be an ancestor when the clicked
    // entity was granular - the UI surfaces that approximation).
    const resolved = parsed.entity ? toBrief(parsed.entity) : null;
    const dependents = (parsed.dependents ?? []).filter(
      (item) => item.entityId != null,
    );
    const tests = (parsed.tests ?? []).filter((item) => item.entityId != null);
    const impactEntities = parsed.impact?.entities ?? [];
    const depth = impactEntities.length
      ? Math.max(...impactEntities.map((item) => Number(item.depth ?? 1)))
      : 0;
    return {
      status: "ok",
      dependents: dependents.map(toBrief),
      tests: tests.map(toBrief),
      total: Number(parsed.impact?.total ?? dependents.length),
      depth,
      resolvedAs: resolved,
    };
  } catch (cause) {
    return {
      status: "unavailable",
      reason:
        cause instanceof Error ? cause.message : "sem impact failed to run",
    };
  }
}

export async function runEntityDiff(
  inputs: SemDiffInput[],
): Promise<SemDiffResult> {
  if (inputs.length === 0) return { status: "ok", changes: [] };
  if (!semBinaryPath()) {
    return {
      status: "unavailable",
      reason:
        "sem binary not found (install sem-cli or add the optional @ataraxy-labs/sem dependency)",
    };
  }
  try {
    const raw = await spawnSem(
      ["diff", "--stdin", "--format", "json"],
      buildSemStdinPayload(inputs),
    );
    return {
      status: "ok",
      changes: parseSemJson(raw).changes.filter((change) =>
        Boolean(change.entityId),
      ),
    };
  } catch (cause) {
    return {
      status: "unavailable",
      reason: cause instanceof Error ? cause.message : "sem diff failed to run",
    };
  }
}

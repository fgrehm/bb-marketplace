
/**
 * Pi exposes no model exclusion setting. `enabledModels` is an allowlist of
 * patterns (`provider/id`, fuzzy id/name, or a glob) used for startup selection
 * and `Ctrl+P` cycling. See the Pi settings reference for details.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface PiModelSummary {
  provider: string;
  id: string;
  name: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  images: boolean;
}

export interface PiModelList {
  models: PiModelSummary[];
  /** Human-readable reason the list is empty, or null when models were read. */
  error: string | null;
}

export function modelReference(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function splitThinkingSuffix(pattern: string): { pattern: string; thinkingLevel: ThinkingLevel | null } {
  const index = pattern.lastIndexOf(":");
  if (index === -1) return { pattern, thinkingLevel: null };
  const suffix = pattern.slice(index + 1);
  const level = (THINKING_LEVELS as readonly string[]).includes(suffix) ? (suffix as ThinkingLevel) : null;
  return { pattern: level === null ? pattern : pattern.slice(0, index), thinkingLevel: level };
}

/**
 * Pi passes `enabledModels` globs to minimatch without `nonegate`, so a `!`
 * prefix is read as a negation and can match nearly every model. Patterns
 * without glob characters never reach minimatch, so `!` there only ever
 * produces a "no models match" warning. Either way `!` is not a supported way
 * to exclude models.
 */
export function isNegatedPattern(pattern: string): boolean {
  return pattern.trim().startsWith("!");
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      // Match within a single path segment, like minimatch.
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
        while (glob[index + 1] === "*") index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const close = glob.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      const body = glob.slice(index + 1, close);
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = close;
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

function isGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

export function isGlobPattern(pattern: string): boolean {
  return isGlob(splitThinkingSuffix(pattern).pattern);
}

/**
 * Approximates pi's own pattern resolution: exact `provider/id` or bare id,
 * then a case-insensitive glob, then a fuzzy substring match on id and name.
 * Used only to report how many models a pattern covers.
 */
export function matchesModelPattern(pattern: string, models: PiModelSummary[]): PiModelSummary[] {
  const { pattern: needle } = splitThinkingSuffix(pattern.trim());
  if (needle === "") return [];
  if (isGlob(needle)) {
    const expression = globToRegExp(needle);
    return models.filter(
      (model) => expression.test(modelReference(model)) || expression.test(model.id),
    );
  }
  const lowered = needle.toLowerCase();
  const exact = models.filter(
    (model) => modelReference(model).toLowerCase() === lowered || model.id.toLowerCase() === lowered,
  );
  if (exact.length > 0) return exact;
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(lowered) || (model.name?.toLowerCase().includes(lowered) ?? false),
  );
}

/**
 * Patterns that resolve to no currently available model. Pi reports these as
 * "No models match pattern" warnings and drops them, so the panel keeps them
 * visible instead of deleting a model that may return later.
 */
export function unresolvedPatterns(patterns: string[], models: PiModelSummary[]): string[] {
  return patterns.filter((pattern) => !isNegatedPattern(pattern) && matchesModelPattern(pattern, models).length === 0);
}

/**
 * Rebuilds the pattern list from a checkbox selection. Globs that still cover
 * exactly the checked models are kept verbatim so future models stay in scope;
 * everything else becomes an exact `provider/id`. Patterns that resolve to no
 * available model (including `!` patterns) are preserved untouched, because pi
 * only warns about them and they may start matching again.
 *
 * The default model reference is placed first so pi starts on it: pi resolves
 * the scope to a list and uses the first entry, ignoring `defaultModel`.
 */
export function buildScopePatterns(
  checked: ReadonlySet<string>,
  original: readonly string[],
  models: PiModelSummary[],
  defaultRef: string | null,
): string[] {
  const covered = new Set<string>();
  const preserved: string[] = [];
  for (const pattern of original) {
    const matched = matchesModelPattern(pattern, models).map(modelReference);
    if (matched.length === 0) {
      preserved.push(pattern);
      continue;
    }
    if (!isGlobPattern(pattern) || !matched.every((reference) => checked.has(reference))) continue;
    preserved.push(pattern);
    for (const reference of matched) covered.add(reference);
  }
  const rest = models
    .map(modelReference)
    .filter((reference) => checked.has(reference) && !covered.has(reference));
  const head = defaultRef !== null && checked.has(defaultRef) ? [defaultRef] : [];
  return [...head, ...preserved, ...rest.filter((reference) => !head.includes(reference))];
}

/**
 * Converts a scope selection into the value written to settings. Returns null
 * when every available model is selected and no pattern is unresolved, matching
 * pi's own behavior of dropping the key entirely in that case.
 */
export function scopeForSettings(patterns: string[], models: PiModelSummary[]): string[] | null {
  const references = models.map(modelReference);
  if (patterns.length === 0 || references.length === 0) return null;
  if (unresolvedPatterns(patterns, models).length > 0) return patterns;
  const covered = new Set(patterns.flatMap((pattern) => matchesModelPattern(pattern, models).map(modelReference)));
  if (references.every((reference) => covered.has(reference))) return null;
  return patterns;
}

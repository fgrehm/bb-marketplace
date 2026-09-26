import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { piExtrasRpcContract } from "./contract";
import type { PiSettings } from "./pi-settings";
import {
  THINKING_LEVELS,
  buildScopePatterns,
  isNegatedPattern,
  matchesModelPattern,
  modelReference,
  scopeForSettings,
  unresolvedPatterns,
  type PiModelSummary,
} from "./model-scope";
import { UpdateActions } from "./update-actions";

const FIELD_CLASS = "w-full rounded-md border border-input bg-background px-2 py-1";
/** Sentinel for a saved model that Pi's available list does not contain. */
const UNAVAILABLE = "(not available)";

function formatTokens(count: number | null): string {
  if (count === null) return "";
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}K`;
  return String(count);
}

function matchesFilter(model: PiModelSummary, filter: string): boolean {
  if (filter === "") return true;
  const lowered = filter.toLowerCase();
  return (
    modelReference(model).toLowerCase().includes(lowered) ||
    (model.name?.toLowerCase().includes(lowered) ?? false)
  );
}

function groupByProvider(models: PiModelSummary[]): Array<[string, PiModelSummary[]]> {
  const groups = new Map<string, PiModelSummary[]>();
  for (const model of models) {
    const existing = groups.get(model.provider);
    if (existing === undefined) groups.set(model.provider, [model]);
    else existing.push(model);
  }
  return [...groups];
}

function placeholderModel(reference: string): PiModelSummary {
  const separator = reference.indexOf("/");
  return {
    provider: reference.slice(0, separator),
    id: reference.slice(separator + 1),
    name: null,
    contextWindow: null,
    maxTokens: null,
    reasoning: false,
    images: false,
  };
}

export function PiSettingsPanel() {
  const rpc = useRpc<typeof piExtrasRpcContract>();
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [draft, setDraft] = useState<PiSettings | null>(null);
  const [models, setModels] = useState<PiModelSummary[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelFilter, setModelFilter] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [message, setMessage] = useState("");
  const [updateOutput, setUpdateOutput] = useState("");
  const [updating, setUpdating] = useState<"models" | "plugins" | "pinned" | null>(null);

  const loadModels = useCallback(
    async (force: boolean) => {
      setModelsLoading(true);
      try {
        const result = await rpc.call("listModels", { force });
        setModels(result.models);
        setModelsError(result.error);
      } catch (error) {
        setModels([]);
        setModelsError(error instanceof Error ? error.message : String(error));
      } finally {
        setModelsLoading(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    void rpc.call("readSettings", {}).then((value) => {
      setSettings(value);
      setDraft(value);
    }).catch((error) => setMessage(String(error)));
    void loadModels(false);
  }, [rpc, loadModels]);

  const dirty =
    settings !== null && draft !== null && JSON.stringify(settings) !== JSON.stringify(draft);

  // BB unmounts the settings section when it leaves the settings route, so a
  // fresh mount already re-reads Pi. Re-read on focus as well, but never while
  // the user has unsaved edits.
  useEffect(() => {
    if (dirty) return;
    const reload = () => {
      if (document.visibilityState !== "visible") return;
      void rpc.call("readSettings", {}).then((value) => {
        setSettings(value);
        setDraft(value);
      }).catch(() => undefined);
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [dirty, rpc]);

  const defaultRef = useMemo(() => {
    if (draft === null || draft.defaultProvider === null || draft.defaultModel === null) return null;
    return `${draft.defaultProvider}/${draft.defaultModel}`;
  }, [draft]);

  const defaultAvailable = useMemo(
    () =>
      defaultRef !== null &&
      models.some((model) => modelReference(model).toLowerCase() === defaultRef.toLowerCase()),
    [defaultRef, models],
  );

  const scope = draft?.enabledModels ?? [];
  const coveredRefs = useMemo(
    () => new Set(scope.flatMap((pattern) => matchesModelPattern(pattern, models).map(modelReference))),
    [scope, models],
  );
  const unresolved = useMemo(() => unresolvedPatterns(scope, models), [scope, models]);
  const negated = useMemo(() => scope.filter(isNegatedPattern), [scope]);
  const scopeIsEmpty = scope.length === 0;
  const visibleModels = useMemo(
    () => models.filter((model) => matchesFilter(model, modelFilter)),
    [models, modelFilter],
  );
  const visibleProviders = useMemo(() => groupByProvider(visibleModels), [visibleModels]);
  // Keep the current selection in the list even when a filter hides it, so the
  // select does not fall back to another entry.
  const selectableModels = useMemo(
    () =>
      defaultRef === null || defaultAvailable || visibleModels.some((model) => modelReference(model) === defaultRef)
        ? visibleModels
        : [...visibleModels, placeholderModel(defaultRef)],
    [visibleModels, defaultRef, defaultAvailable],
  );
  const selectableProviders = useMemo(() => groupByProvider(selectableModels), [selectableModels]);
  const writtenScope = useMemo(() => scopeForSettings(scope, models), [scope, models]);
  const coversEverything =
    models.length > 0 &&
    writtenScope === null &&
    (scopeIsEmpty || coveredRefs.size === models.length);

  if (!draft) return <p className="text-sm text-muted-foreground">Loading Pi settings... {message}</p>;

  const setScope = (patterns: string[]) => setDraft({ ...draft, enabledModels: patterns });

  const applyChecked = (checked: Set<string>) =>
    setScope(buildScopePatterns(checked, scope, models, defaultRef));

  const toggleModel = (reference: string, next: boolean) => {
    const checked = new Set(coveredRefs);
    if (next) checked.add(reference);
    else checked.delete(reference);
    applyChecked(checked);
  };

  const toggleModels = (references: string[], next: boolean) => {
    const checked = new Set(coveredRefs);
    for (const reference of references) {
      if (next) checked.add(reference);
      else checked.delete(reference);
    }
    applyChecked(checked);
  };

  const selectDefaultModel = (reference: string) => {
    if (reference === "" || reference === UNAVAILABLE) {
      if (reference === "") setDraft({ ...draft, defaultProvider: null, defaultModel: null });
      return;
    }
    const separator = reference.indexOf("/");
    const provider = reference.slice(0, separator);
    const id = reference.slice(separator + 1);
    // While a scope exists, Pi starts on the scope's first entry and ignores
    // the default model, so keep the chosen model first in the scope.
    const checked = new Set(coveredRefs);
    checked.add(reference);
    setDraft({
      ...draft,
      defaultProvider: provider,
      defaultModel: id,
      enabledModels: scopeIsEmpty ? scope : buildScopePatterns(checked, scope, models, reference),
    });
  };

  const save = async () => {
    setMessage("Saving...");
    try {
      // An empty scope means "every available model", which pi stores by
      // omitting the key entirely.
      const next = { ...draft, enabledModels: writtenScope ?? [] };
      const saved = await rpc.call("writeSettings", next);
      setSettings(saved);
      setDraft(saved);
      setMessage("Saved");
    } catch (error) {
      setMessage(String(error));
    }
  };

  const update = async (target: "models" | "plugins" | "pinned") => {
    setUpdating(target);
    setMessage("");
    setUpdateOutput("");
    try {
      const result = await rpc.call("update", { target });
      const labels = target === "models"
        ? ["Model catalogs refreshed", "Model refresh failed"]
        : target === "plugins"
          ? ["Pi extensions updated", "Pi extension update failed"]
          : ["Pinned packages updated", "Pinned package update failed"];
      setMessage(labels[result.ok ? 0 : 1]!);
      setUpdateOutput(result.output || "No output.");
      // A refreshed catalog changes which models exist.
      if (target === "models") await loadModels(true);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setUpdating(null);
    }
  };

  return <div className="space-y-6 text-sm">
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Model defaults</h3>
        <button
          type="button"
          onClick={() => void loadModels(true)}
          disabled={modelsLoading}
          className="rounded-md border border-input px-2 py-1 text-xs disabled:opacity-50"
        >
          {modelsLoading ? "Loading models..." : `Refresh list (${models.length})`}
        </button>
      </div>

      {modelsError !== null ? (
        <p role="status" className="rounded-md border border-destructive/30 p-2 text-xs text-destructive">
          {modelsError} Model values stay editable below.
        </p>
      ) : null}

      {defaultRef !== null && !defaultAvailable ? (
        <p className="rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground">
          <code>{defaultRef}</code> is not in Pi&apos;s available list. It may have been retired, the
          catalog may be stale, or its provider may not be signed in. Pi starts on another model
          instead. The value is kept as saved.
        </p>
      ) : null}

      <div>
        <label className="mb-1 block font-medium" htmlFor="pi-default-model">
          Default model
        </label>
        <input
          className={`${FIELD_CLASS} mb-1`}
          placeholder="Filter models"
          value={modelFilter}
          onChange={(event) => setModelFilter(event.target.value)}
          aria-label="Filter models"
        />
        <select
          id="pi-default-model"
          className={FIELD_CLASS}
          value={defaultRef === null ? "" : defaultAvailable ? defaultRef : UNAVAILABLE}
          onChange={(event) => selectDefaultModel(event.target.value)}
        >
          <option value="">Pi default (automatic)</option>
          {defaultRef !== null && !defaultAvailable ? (
            <option value={UNAVAILABLE}>{defaultRef} (not in Pi&apos;s list)</option>
          ) : null}
          {selectableProviders.map(([provider, providerModels]) => (
            <optgroup key={provider} label={provider}>
              {providerModels.map((model) => {
                const reference = modelReference(model);
                return <option key={reference} value={reference}>
                  {model.id}
                  {coveredRefs.has(reference) ? " (in scope)" : ""}
                  {model.reasoning ? " thinking" : ""}
                  {model.images ? " images" : ""}
                </option>;
              })}
            </optgroup>
          ))}
        </select>
      </div>

      {scopeIsEmpty ? (
        <p className="text-xs text-muted-foreground">
          No model scope is set, so Pi uses every available model and this default applies at startup.
        </p>
      ) : (
        <p className="rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground">
          A model scope is set, so Pi starts on its first entry and ignores the default model
          {defaultRef !== null ? (
            <>
              {" "}(<code>{defaultRef}</code> is kept first in the scope)
            </>
          ) : null}
          .
        </p>
      )}

      <div>
        <label className="mb-1 block font-medium" htmlFor="pi-thinking-level">
          Default thinking level
        </label>
        <select
          id="pi-thinking-level"
          className={FIELD_CLASS}
          value={draft.defaultThinkingLevel ?? ""}
          onChange={(event) => setDraft({ ...draft, defaultThinkingLevel: (event.target.value || null) as PiSettings["defaultThinkingLevel"] })}
        >
          <option value="">Pi default</option>
          {THINKING_LEVELS.map((level) => <option key={level}>{level}</option>)}
        </select>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          className="text-xs underline underline-offset-2"
          onClick={() => setAdvanced((value) => !value)}
          aria-expanded={advanced}
        >
          {advanced ? "Hide raw provider and model" : "Edit provider and model as raw values"}
        </button>
        {advanced ? (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block font-medium">Default provider</span>
              <input
                className={FIELD_CLASS}
                value={draft.defaultProvider ?? ""}
                onChange={(event) => setDraft({ ...draft, defaultProvider: event.target.value || null })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Default model id</span>
              <input
                className={FIELD_CLASS}
                value={draft.defaultModel ?? ""}
                onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value || null })}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Pi stores the provider and the model id separately. Choosing a model from the list
              above writes both together.
            </p>
          </div>
        ) : null}
      </div>
    </section>

    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Model scope</h3>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md border border-input px-2 py-1 text-xs disabled:opacity-50"
            disabled={models.length === 0}
            onClick={() => setScope(models.map(modelReference))}
          >
            Select all
          </button>
          <button
            type="button"
            className="rounded-md border border-input px-2 py-1 text-xs disabled:opacity-50"
            disabled={scopeIsEmpty}
            onClick={() => setScope([])}
          >
            Clear
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Pi has no model exclusion setting. The scope is an allowlist: it decides which models Pi
        offers and which one it starts on. Leave it empty, or select everything, for every available
        model.
      </p>
      <p className="text-xs text-muted-foreground">
        {coversEverything
          ? "Every available model is in scope, so no scope is written to settings."
          : `${coveredRefs.size} of ${models.length} models in scope.`}
      </p>

      {visibleProviders.length === 0 && !modelsLoading ? (
        <p className="text-xs text-muted-foreground">No models match the filter.</p>
      ) : null}

      <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border border-border p-2">
        {visibleProviders.map(([provider, providerModels]) => {
          const providerRefs = providerModels.map(modelReference);
          const selectedCount = providerRefs.filter((reference) => coveredRefs.has(reference)).length;
          return <fieldset key={provider} className="space-y-1">
            <legend className="flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={providerModels.length > 0 && selectedCount === providerModels.length}
                onChange={(event) => toggleModels(providerRefs, event.target.checked)}
                aria-label={`Toggle the listed ${provider} models`}
              />
              {provider}
              <span className="text-muted-foreground">{selectedCount}/{providerModels.length}</span>
            </legend>
            <div className="ml-5 space-y-1">
              {providerModels.map((model) => {
                const reference = modelReference(model);
                const isDefault =
                  defaultRef !== null && reference.toLowerCase() === defaultRef.toLowerCase();
                return <label key={reference} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={coveredRefs.has(reference)}
                    onChange={(event) => toggleModel(reference, event.target.checked)}
                  />
                  <span className="font-mono">{model.id}</span>
                  <span className="text-muted-foreground">
                    {formatTokens(model.contextWindow)}
                    {model.reasoning ? " thinking" : ""}
                    {model.images ? " images" : ""}
                  </span>
                  {isDefault ? <span className="text-muted-foreground">(default)</span> : null}
                </label>;
              })}
            </div>
          </fieldset>;
        })}
      </div>

      {unresolved.length > 0 || negated.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Pi reports no match for these patterns and skips them at startup. They are kept in case a
            model or provider returns.
          </p>
          <div className="flex flex-wrap gap-2">
            {[...new Set([...unresolved, ...negated])].map((pattern) => (
              <span
                key={pattern}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-mono text-xs"
              >
                {pattern}
                {isNegatedPattern(pattern) ? (
                  <span className="text-destructive">unsafe</span>
                ) : null}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => setScope(scope.filter((entry) => entry !== pattern))}
                  aria-label={`Remove pattern ${pattern}`}
                >
                  remove
                </button>
              </span>
            ))}
          </div>
          {negated.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              <code>!</code> is not an exclusion syntax here. A pattern with glob characters reaches
              Pi&apos;s glob matcher, where the prefix inverts the match and can select nearly every
              model.
            </p>
          ) : null}
        </div>
      ) : null}

      <details className="text-xs">
        <summary className="cursor-pointer">Patterns written to settings.json</summary>
        <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-muted p-2 font-mono">
          {writtenScope === null
            ? "(no enabledModels key: every available model is in scope)"
            : writtenScope.join("\n")}
        </pre>
      </details>
    </section>

    <section className="space-y-3">
      <h3 className="font-medium">Maintenance</h3>
      <UpdateActions updating={updating} onUpdate={(target) => void update(target)} />
      {updateOutput ? <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-3 text-xs whitespace-pre-wrap">{updateOutput}</pre> : null}
    </section>

    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={!dirty}
        className="rounded-md border border-input px-3 py-1.5 disabled:opacity-50"
        onClick={() => void save()}
      >
        Save settings
      </button>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  </div>;
}

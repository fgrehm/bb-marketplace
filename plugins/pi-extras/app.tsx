import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { piExtrasRpcContract } from "./contract";
import type { UsageSource } from "./usage";
import { UsagePage } from "./usage-page/components/usage/usage-page";
import { ProviderMark } from "./usage-page/components/usage/providers";
import "./usage-page/app.css";

type Tab = "sessions" | "subscriptions";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "subscriptions", label: "Subscriptions" },
];

interface UsageView {
  hostName: string | null;
  sources: UsageSource[];
}

type PiSettings = {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: "minimal" | "low" | "medium" | "high" | null;
  enabledModels: string[];
};

function formatReset(resetsAt: string | null): string {
  if (resetsAt === null) return "Reset time unavailable";
  return `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(resetsAt))}`;
}


function UsageCard({ source }: { source: UsageSource }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-labelledby={`${source.id}-title`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={`${source.id}-title`} className="flex items-center gap-2 font-medium">
          <ProviderMark provider={source.id} className="size-5 shrink-0" />
          {source.label}
        </h2>
        <span className="text-xs text-muted-foreground">{source.status === "ok" ? "Connected" : source.status.replace("_", " ")}</span>
      </div>
      {source.status !== "ok" ? <p className="mt-3 text-sm text-muted-foreground">{source.message}</p> : (
        <div className="mt-4 space-y-4">
          {source.windows.map((window) => (
            <div key={window.label}>
              <div className="flex justify-between gap-3 text-sm">
                <span>{window.label}</span><span>{window.usedPercent}% used</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${source.label} ${window.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent}>
                <div className="h-full rounded-full bg-primary" style={{ width: `${window.usedPercent}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{formatReset(window.resetsAt)}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CredentialsPage() {
  const rpc = useRpc<typeof piExtrasRpcContract>();
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUsage(await rpc.call("refreshUsage", { force: true }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load usage.");
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <main className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">Subscription usage from credentials stored by Pi.{usage?.hostName ? ` Primary machine: ${usage.hostName}.` : ""}</p>
            <p className="mt-1 text-xs text-muted-foreground">Credentials are never shown, logged, sent to BB, or changed.</p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {error === null ? null : <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
        {usage === null ? <p role="status" className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Loading usage...</p> : <div className="grid gap-4 md:grid-cols-3">{usage.sources.map((source) => <UsageCard key={source.id} source={source} />)}</div>}
      </div>
    </main>
  );
}

function PiSettings() {
  const rpc = useRpc<typeof piExtrasRpcContract>();
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { void rpc.call("readSettings", {}).then((value) => setSettings(value as PiSettings)).catch((error) => setMessage(String(error))); }, [rpc]);
  if (!settings) return <p className="text-sm text-muted-foreground">Loading Pi settings... {message}</p>;
  const save = (patch: Partial<PiSettings>) => { const next: PiSettings = { ...settings, ...patch }; setSettings(next); void rpc.call("writeSettings", next).then(() => setMessage("Saved")).catch((error) => setMessage(String(error))); };
  return <div className="space-y-4 text-sm">
    <label className="block"><span className="mb-1 block font-medium">Default provider</span><input className="w-full rounded-md border border-input bg-background px-2 py-1" value={settings.defaultProvider ?? ""} onChange={(event) => save({ defaultProvider: event.target.value || null })} /></label>
    <label className="block"><span className="mb-1 block font-medium">Default model</span><input className="w-full rounded-md border border-input bg-background px-2 py-1" value={settings.defaultModel ?? ""} onChange={(event) => save({ defaultModel: event.target.value || null })} /></label>
    <label className="block"><span className="mb-1 block font-medium">Default thinking level</span><select className="w-full rounded-md border border-input bg-background px-2 py-1" value={settings.defaultThinkingLevel ?? ""} onChange={(event) => save({ defaultThinkingLevel: (event.target.value || null) as typeof settings.defaultThinkingLevel })}><option value="">Pi default</option>{["minimal", "low", "medium", "high"].map((level) => <option key={level}>{level}</option>)}</select></label>
    <label className="block"><span className="mb-1 block font-medium">Enabled model patterns</span><textarea className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs" value={settings.enabledModels.join("\n")} onChange={(event) => save({ enabledModels: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) })} /></label>
    {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    <div className="flex gap-2"><button type="button" className="rounded-md border border-input px-3 py-1.5" onClick={() => void rpc.call("update", { target: "models" }).then(() => setMessage("Model catalogs refreshed")).catch((error) => setMessage(String(error)))}>Refresh models</button><button type="button" className="rounded-md border border-input px-3 py-1.5" onClick={() => void rpc.call("update", { target: "plugins" }).then(() => setMessage("Pi plugins updated")).catch((error) => setMessage(String(error)))}>Update plugins</button></div>
  </div>;
}

function ExtrasPage() {
  const [tab, setTab] = useState<Tab>("sessions");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Pi Usage sections" className="flex gap-1 border-b border-border px-4 pt-2 md:px-5">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? "page" : undefined}
            className={`rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors ${tab === entry.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {tab === "sessions" ? <UsagePage /> : <CredentialsPage />}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "pi-settings", title: "Pi Usage", description: "Configure global Pi model defaults and updates.", component: PiSettings });
  app.slots.navPanel({
    id: "pi-extras",
    title: "Pi Usage",
    icon: "ChartNoAxesCombined",
    path: "usage",
    component: ExtrasPage,
  });
});

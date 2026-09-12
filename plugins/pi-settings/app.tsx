import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { piSettingsRpcContract } from "./contract";

type PiSettings = {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: "minimal" | "low" | "medium" | "high" | null;
  enabledModels: string[];
};

function PiSettings() {
  const rpc = useRpc<typeof piSettingsRpcContract>();
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


export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "pi-settings",
    title: "Pi Settings",
    description: "Configure global Pi model defaults and updates.",
    component: PiSettings,
  });
});

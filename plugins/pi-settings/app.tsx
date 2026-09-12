import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { piSettingsRpcContract } from "./contract";
import { UpdateActions } from "./update-actions";

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
  const [updateOutput, setUpdateOutput] = useState("");
  const [updating, setUpdating] = useState<"models" | "plugins" | null>(null);
  useEffect(() => { void rpc.call("readSettings", {}).then((value) => setSettings(value as PiSettings)).catch((error) => setMessage(String(error))); }, [rpc]);
  if (!settings) return <p className="text-sm text-muted-foreground">Loading Pi settings... {message}</p>;
  const save = (patch: Partial<PiSettings>) => { const next: PiSettings = { ...settings, ...patch }; setSettings(next); void rpc.call("writeSettings", next).then(() => setMessage("Saved")).catch((error) => setMessage(String(error))); };
  const update = async (target: "models" | "plugins") => {
    setUpdating(target); setMessage(""); setUpdateOutput("");
    try { const result = await rpc.call("update", { target }); setMessage(target === "models" ? "Model catalogs refreshed" : "Pi plugins updated"); setUpdateOutput(result.output || "No output."); }
    catch (error) { setMessage(String(error)); }
    finally { setUpdating(null); }
  };
  return <div className="space-y-4 text-sm">
    <label className="block"><span className="mb-1 block font-medium">Default provider</span><input className="w-full rounded-md border border-input bg-background px-2 py-1" value={settings.defaultProvider ?? ""} onChange={(event) => save({ defaultProvider: event.target.value || null })} /></label>
    <label className="block"><span className="mb-1 block font-medium">Default model</span><input className="w-full rounded-md border border-input bg-background px-2 py-1" value={settings.defaultModel ?? ""} onChange={(event) => save({ defaultModel: event.target.value || null })} /></label>
    <label className="block"><span className="mb-1 block font-medium">Default thinking level</span><select className="w-full rounded-md border border-input bg-background px-2 py-1" value={settings.defaultThinkingLevel ?? ""} onChange={(event) => save({ defaultThinkingLevel: (event.target.value || null) as PiSettings["defaultThinkingLevel"] })}><option value="">Pi default</option>{["minimal", "low", "medium", "high"].map((level) => <option key={level}>{level}</option>)}</select></label>
    <label className="block"><span className="mb-1 block font-medium">Enabled model patterns</span><textarea className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs" value={settings.enabledModels.join("\n")} onChange={(event) => save({ enabledModels: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) })} /></label>
    {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    <UpdateActions updating={updating} onUpdate={update} />
    {updateOutput ? <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-3 text-xs whitespace-pre-wrap">{updateOutput}</pre> : null}
  </div>;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "pi-settings", title: "Pi Settings", description: "Configure global Pi model defaults and updates.", component: PiSettings });
});

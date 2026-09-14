import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { piExtrasRpcContract } from "./contract";
import type { PiSettings } from "./pi-settings";
import { UpdateActions } from "./update-actions";

export function PiSettingsPanel() {
  const rpc = useRpc<typeof piExtrasRpcContract>();
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [draft, setDraft] = useState<PiSettings | null>(null);
  const [message, setMessage] = useState("");
  const [updateOutput, setUpdateOutput] = useState("");
  const [updating, setUpdating] = useState<"models" | "plugins" | "pinned" | null>(null);

  useEffect(() => {
    void rpc.call("readSettings", {}).then((value) => {
      setSettings(value);
      setDraft(value);
    }).catch((error) => setMessage(String(error)));
  }, [rpc]);

  if (!draft) return <p className="text-sm text-muted-foreground">Loading Pi settings... {message}</p>;

  const save = async () => {
    setMessage("Saving...");
    try {
      const saved = await rpc.call("writeSettings", draft);
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
    } catch (error) {
      setMessage(String(error));
    } finally {
      setUpdating(null);
    }
  };

  return <div className="space-y-6 text-sm">
    <section className="space-y-4">
      <h3 className="font-medium">Model defaults</h3>
      <label className="block"><span className="mb-1 block font-medium">Default provider</span><input className="w-full rounded-md border border-input bg-background px-2 py-1" value={draft.defaultProvider ?? ""} onChange={(event) => setDraft({ ...draft, defaultProvider: event.target.value || null })} /></label>
      <label className="block"><span className="mb-1 block font-medium">Default model</span><input className="w-full rounded-md border border-input bg-background px-2 py-1" value={draft.defaultModel ?? ""} onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value || null })} /></label>
      <label className="block"><span className="mb-1 block font-medium">Default thinking level</span><select className="w-full rounded-md border border-input bg-background px-2 py-1" value={draft.defaultThinkingLevel ?? ""} onChange={(event) => setDraft({ ...draft, defaultThinkingLevel: (event.target.value || null) as PiSettings["defaultThinkingLevel"] })}><option value="">Pi default</option>{["minimal", "low", "medium", "high"].map((level) => <option key={level}>{level}</option>)}</select></label>
      <label className="block"><span className="mb-1 block font-medium">Enabled model patterns</span><textarea className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs" value={draft.enabledModels.join("\n")} onChange={(event) => setDraft({ ...draft, enabledModels: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) })} /></label>
      <button type="button" disabled={JSON.stringify(settings) === JSON.stringify(draft)} className="rounded-md border border-input px-3 py-1.5 disabled:opacity-50" onClick={() => void save()}>Save settings</button>
    </section>
    <section className="space-y-3">
      <h3 className="font-medium">Maintenance</h3>
      <UpdateActions updating={updating} onUpdate={(target) => void update(target)} />
      {updateOutput ? <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-3 text-xs whitespace-pre-wrap">{updateOutput}</pre> : null}
    </section>
    {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
  </div>;
}

import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { piExtrasRpcContract } from "./contract";
import { modelReference, type PiModelSummary } from "./model-scope";

export function TitleServiceSettings({ models }: { models: PiModelSummary[] }) {
  const rpc = useRpc<typeof piExtrasRpcContract>();
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<{ ready: true } | { ready: false; message: string } | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void rpc.call("readTitleSettings", {}).then(({ titleModel }) => {
      setSaved(titleModel);
      setDraft(titleModel);
    }).catch((error) => setMessage(String(error)));
    void rpc.call("titleServiceStatus", {}).then(setStatus).catch(() => undefined);
  }, [rpc]);

  const options = models.map(modelReference);
  // Keep a saved model even if its provider is no longer available.
  if (draft && !options.includes(draft)) options.push(draft);

  const save = async () => {
    setMessage("Saving...");
    try {
      const { titleModel } = await rpc.call("writeTitleSettings", { titleModel: draft });
      setSaved(titleModel);
      setDraft(titleModel);
      setMessage("Saved");
    } catch (error) {
      setMessage(String(error));
    }
  };

  return <div className="space-y-3 text-xs">
    <p className="text-muted-foreground">
      To use Pi for thread titles, select it under Settings &rarr; AI services. This model choice
      does not change the model used by BB threads or standalone Pi.
    </p>
    {status?.ready ? <p>Pi is ready to name threads.</p> : status ? <p role="status" className="text-destructive">{status.message}</p> : null}
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span>Model for thread titles</span>
        <select className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={draft} disabled={saved === null} onChange={(event) => setDraft(event.target.value)}>
          <option value="">Pi default (no override)</option>
          {options.map((reference) => <option key={reference} value={reference}>{reference}</option>)}
        </select>
      </label>
      <button type="button" disabled={saved === null || draft === saved}
        className="rounded-md border border-input px-3 py-1.5 disabled:opacity-50" onClick={() => void save()}>
        Save
      </button>
      {message ? <p className="text-muted-foreground">{message}</p> : null}
    </div>
  </div>;
}

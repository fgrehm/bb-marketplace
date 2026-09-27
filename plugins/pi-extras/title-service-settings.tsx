import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { piExtrasRpcContract } from "./contract";
import { modelReference, type PiModelSummary } from "./model-scope";

const SELECT_CLASS =
  "rounded-md border border-input bg-background px-2 py-1 text-sm";

export function TextServiceSettings({ models }: { models: PiModelSummary[] }) {
  const rpc = useRpc<typeof piExtrasRpcContract>();
  const [saved, setSaved] = useState<{ titleModel: string; commitModel: string } | null>(null);
  const [draft, setDraft] = useState({ titleModel: "", commitModel: "" });
  const [status, setStatus] = useState<{ ready: true } | { ready: false; message: string } | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void rpc.call("readTitleSettings", {}).then((next) => {
      setSaved(next);
      setDraft(next);
    }).catch((error) => setMessage(String(error)));
    void rpc.call("titleServiceStatus", {}).then(setStatus).catch(() => undefined);
  }, [rpc]);

  // Keep a saved model even if its provider is no longer available.
  const options = models.map(modelReference);
  for (const reference of [draft.titleModel, draft.commitModel]) {
    if (reference && !options.includes(reference)) options.push(reference);
  }

  const save = async () => {
    setMessage("Saving...");
    try {
      const next = await rpc.call("writeTitleSettings", draft);
      setSaved(next);
      setDraft(next);
      setMessage("Saved");
    } catch (error) {
      setMessage(String(error));
    }
  };

  const picker = (
    label: string,
    key: "titleModel" | "commitModel",
    hint: string,
    emptyLabel: string,
  ) => (
    <label className="flex min-w-64 flex-col gap-1">
      <span>{label}</span>
      <select
        className={SELECT_CLASS}
        value={draft[key]}
        disabled={saved === null}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      >
        <option value="">{emptyLabel}</option>
        {options.map((reference) => (
          <option key={`${key}-${reference}`} value={reference}>{reference}</option>
        ))}
      </select>
      <span className="text-muted-foreground">{hint}</span>
    </label>
  );

  return <div className="space-y-3 text-xs">
    <p className="text-muted-foreground">
      Pi answers BB&apos;s prompts for thread titles and, when selected for it, commit messages. Pick
      each under Settings &rarr; AI services. Neither choice changes the model BB threads use or
      standalone Pi.
    </p>
    {status?.ready ? <p>Pi is ready.</p> : status ? <p role="status" className="text-destructive">{status.message}</p> : null}
    <div className="flex flex-wrap items-start gap-4">
      {picker("Model for thread titles", "titleModel", "Short prompts, so most models manage.", "Pi default (no override)")}
      {picker(
        "Model for commit messages",
        "commitModel",
        "Commit prompts carry a diff and are slower. Falls back to the title model.",
        "Same as thread titles",
      )}
      <button
        type="button"
        className="self-end rounded-md border border-input px-3 py-1.5"
        disabled={saved === null || (draft.titleModel === saved.titleModel && draft.commitModel === saved.commitModel)}
        onClick={() => void save()}
      >
        Save
      </button>
    </div>
    {message ? <p className="text-muted-foreground">{message}</p> : null}
  </div>;
}

import { useEffect, useState } from "react";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { KIND_META, type Item } from "../item-model";
import { SourceMark } from "./source-mark";
import { MarkdownBody } from "../markdown-body";
import { plainExcerpt } from "../excerpt-plain";
import { SaveButton } from "./save-button";

export function Reader({ item, note, body, loading, onSaveNote, onBack, onToggleSaved }: { item: Item; note: string; body: string | null; loading: boolean; onSaveNote: (note: string) => Promise<void>; onBack: () => void; onToggleSaved: () => void }) {
  const [noteOpen, setNoteOpen] = useState(Boolean(note));
  const [noteDraft, setNoteDraft] = useState(note);
  useEffect(() => { setNoteDraft((current) => current === "" ? note : current); if (note) setNoteOpen(true); }, [note]);
  const [savedPulse, setSavedPulse] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setNoteError(null);
    try { await onSaveNote(noteDraft); setSavedPulse(true); window.setTimeout(() => setSavedPulse(false), 2500); }
    catch (cause) { setNoteError(cause instanceof Error ? cause.message : "Could not save note."); }
    finally { setSaving(false); }
  };
  const noteDirty = noteDraft !== note;
  return (
    <main className="h-full min-h-0 overflow-y-auto pb-24 max-md:pointer-coarse:pb-28">
      <div className="mx-auto w-full max-w-2xl px-5 py-6 sm:px-8 sm:py-10">
        <button type="button" onClick={onBack} className="-mt-2 mb-8 inline-flex h-9 items-center gap-2 rounded-full text-sm text-muted-foreground hover:text-foreground sm:mb-10"><Icon name="ChevronLeft" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> Back to feed</button>

        <div className="flex items-center gap-3">
          <SourceMark item={item} large />
          <div>
            <p className="font-medium">{item.source}</p>
            <p className="text-xs text-muted-foreground">{item.day === "today" ? "Today" : item.day === "yesterday" ? "Yesterday" : "Published"}, {item.time} · {KIND_META[item.kind].label}</p>
          </div>
          <span className="ml-auto rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{item.tags.join(" ")}</span>
        </div>

        <h1 className="mt-8 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">{item.title}</h1>
        {item.author && <p className="mt-3 text-sm text-muted-foreground">by {item.author}</p>}
        {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-block text-sm underline">Open original</a>}
        <div className="mt-6 text-base leading-7 text-foreground/80">{loading ? <p>Opening content file…</p> : body !== null ? <MarkdownBody body={body} /> : <p>{plainExcerpt(item.body) || "Only metadata is available for this item."}</p>}</div>

        {noteOpen ? (
          <div className="mt-10 rounded-2xl border border-border bg-card/50 p-4">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-amber-400">Your note</p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => { setNoteOpen(false); setNoteDraft(note); }} className="text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground">collapse</button>
                <Button size="sm" className="h-7" disabled={!noteDirty || saving} onClick={() => void save()}>{noteDirty ? "Save" : savedPulse ? "Noted." : "Saved"}</Button>
              </div>
            </div>
            <textarea
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              rows={4}
              placeholder="Why you saved it, what to do with it, who asked you about it…"
              className="mt-3 w-full resize-y rounded-xl bg-background/60 px-3 py-2 font-mono text-sm max-md:pointer-coarse:!text-base leading-6 outline-none placeholder:text-muted-foreground/50 focus:ring-1 focus:ring-primary/60"
            />
            {noteError && <p role="alert" className="mt-2 text-xs text-red-400">{noteError}</p>}
            <p className="mt-2 text-[11px] text-muted-foreground">Saved by JOMO, keyed to this item. Clear the text and save to remove the note.</p>
          </div>
        ) : (
          <div className="mt-10">
            <button type="button" onClick={() => setNoteOpen(true)} className="inline-flex items-center gap-2 rounded-full border border-dashed border-border px-4 py-2 text-xs text-muted-foreground transition-colors hover:border-amber-400/60 hover:text-foreground">
              <Icon name="Edit" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> {note ? "Your note is attached" : "Attach a note"}
            </button>
          </div>
        )}

        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center justify-between text-sm text-muted-foreground">
            <SaveButton item={item} onToggle={onToggleSaved} />

          </div>
        </div>
      </div>
    </main>
  );
}

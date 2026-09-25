import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { KIND_META, type Item, type SavedState } from "../item-model";

type Mark = "save" | "queue";
type Phase = "mark" | "confirm" | "processing" | "done";
type Outcome = { item: Item; outcome: "saved" | "queued" | "already_queued" | "already_present" | "failed"; reason?: string };

/**
 * Salvage: a two-phase review for one source. Mark what is worth keeping
 * first (nothing is fetched yet), then confirm once, then process the marks
 * sequentially and discard everything left unmarked in that source.
 */
export function SalvageView({ items, scopeLabel, onAction, onDiscardIds, onExit, delayMs = 3000, onBusyChange }: { items: Item[]; scopeLabel?: string; onAction: (item: Item, state: SavedState) => Promise<void>; onDiscardIds: (ids: string[]) => Promise<number>; onExit: () => void; delayMs?: number; onBusyChange?: (busy: boolean) => void }) {
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [focus, setFocus] = useState(0);
  const [phase, setPhase] = useState<Phase>("mark");
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [discardedCount, setDiscardedCount] = useState<number | null>(null);
  const processingRef = useRef(false);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const saveIds = items.filter((entry) => marks[entry.id] === "save").map((entry) => entry.id);
  const queueIds = items.filter((entry) => marks[entry.id] === "queue").map((entry) => entry.id);
  const markedCount = saveIds.length + queueIds.length;
  const unmarkedIds = items.filter((entry) => !marks[entry.id]).map((entry) => entry.id);

  const setMark = (id: string, mark: Mark | null) => {
    setMarks((current) => {
      if (mark === null) {
        if (!current[id]) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: mark };
    });
  };
  useEffect(() => { setFocus((current) => Math.min(current, Math.max(0, items.length - 1))); }, [items.length]);
  useEffect(() => { rowRefs.current[focus]?.scrollIntoView?.({ block: "nearest" }); }, [focus]);

  // Salvage keys: j/k move, s marks save, l marks queue, x clears a mark,
  // o reads, Enter finishes, esc exits while marking.
  useEffect(() => {
    if (phase !== "mark") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, a, input, textarea, [contenteditable]")) return;
      if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); setFocus((current) => Math.min(items.length - 1, current + 1)); return; }
      if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); setFocus((current) => Math.max(0, current - 1)); return; }
      const current = items[focus];
      if (!current) return;
      if (event.key === "s") { event.preventDefault(); setMark(current.id, "save"); setFocus((value) => Math.min(items.length - 1, value + 1)); return; }
      if (event.key === "l") { event.preventDefault(); setMark(current.id, "queue"); setFocus((value) => Math.min(items.length - 1, value + 1)); return; }
      if (event.key === "x" || event.key === "Backspace") { event.preventDefault(); setMark(current.id, null); return; }
      if (event.key === "o") { event.preventDefault(); if (current.url) window.open(current.url, "_blank", "noopener,noreferrer"); return; }
      if (event.key === "Enter") { event.preventDefault(); setPhase("confirm"); return; }
      if (event.key === "Escape") { event.preventDefault(); onExit(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, focus, phase]);

  const process = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setPhase("processing");
    onBusyChange?.(true);
    const collected: Outcome[] = [];
    const plan: Array<{ item: Item; mark: Mark }> = items.filter((entry) => marks[entry.id]).map((entry) => ({ item: entry, mark: marks[entry.id] }));
    setProgress({ done: 0, total: plan.length });
    for (const [position, entry] of plan.entries()) {
      // Politeness pause between article fetches, like the links batch:
      // saving 30 items back to back trips rate limiters.
      if (position > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await onAction(entry.item, entry.mark === "save" ? "saved" : "later");
        collected.push({ item: entry.item, outcome: entry.mark === "save" ? "saved" : "queued" });
      } catch (cause) {
        collected.push({ item: entry.item, outcome: "failed", reason: cause instanceof Error ? cause.message : "Could not apply that decision." });
      }
      setOutcomes([...collected]);
      setProgress({ done: collected.length, total: plan.length });
    }
    // Leftovers go only after every mark had its chance; failed marks stay
    // staged so nothing is lost silently.
    const remaining = unmarkedIds;
    setProgress({ done: plan.length, total: plan.length });
    let discarded = 0;
    try { discarded = remaining.length ? await onDiscardIds(remaining) : 0; }
    catch { discarded = 0; }
    setDiscardedCount(discarded);
    processingRef.current = false;
    onBusyChange?.(false);
    setPhase("done");
  };

  if (phase === "processing") {
    return (
      <div className="jomo-enter flex min-h-0 flex-1 flex-col">
        <div className="px-4 pt-3">
          <p className="text-lg font-semibold">Processing salvage…</p>
          <p className="mt-1 text-xs text-muted-foreground">{progress.done} of {progress.total} marks applied · saving fetches the article page</p>
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${progress.total === 0 ? 100 : Math.round((progress.done / progress.total) * 100)}%` }} /></div>
        </div>
        <ul className="mt-4 flex-1 space-y-1 overflow-y-auto px-4 pb-4 text-sm">
          {outcomes.map((outcome, position) => (
            <li key={`${outcome.item.id}:${position}`} className={outcome.outcome === "failed" ? "text-red-400" : "text-muted-foreground"}>
              {outcome.item.title ?? outcome.item.fullName} → {outcome.outcome === "saved" ? "saved" : outcome.outcome === "queued" ? "queued" : `failed (${outcome.reason})`}
            </li>
          ))}
        </ul>
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">Please stay on this screen while the batch finishes.</p>
      </div>
    );
  }

  if (phase === "done") {
    const saved = outcomes.filter((entry) => entry.outcome === "saved").length;
    const queued = outcomes.filter((entry) => entry.outcome === "queued" || entry.outcome === "already_queued").length;
    const failed = outcomes.filter((entry) => entry.outcome === "failed");
    return (
      <div className="jomo-enter grid min-h-0 flex-1 place-items-center px-5">
        <div className="max-w-md text-center">
          <p className="text-3xl max-md:pointer-coarse:text-4xl font-semibold tracking-tight">Salvaged.</p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {saved} saved to the Library · {queued} queued in LINKS.md · {discardedCount ?? 0} discarded.
            {failed.length > 0 && <> {failed.length} could not be applied and stayed staged.</>}
          </p>
          {failed.length > 0 && <ul className="mt-4 space-y-1 text-left text-xs text-red-400">{failed.map((entry, position) => <li key={`${entry.item.id}:${position}`}>{entry.item.title ?? entry.item.fullName}: {entry.reason}</li>)}</ul>}
          <Button variant="outline" size="sm" className="mt-7 h-9 max-md:pointer-coarse:h-10" onClick={onExit}>Done</Button>
        </div>
      </div>
    );
  }

  if (phase === "confirm") {
    return (
      <div className="jomo-enter flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4">
          <p className="text-xl max-md:pointer-coarse:text-2xl font-semibold">Apply this salvage?</p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {saveIds.length} marked to save (fetches {saveIds.length} article page{saveIds.length === 1 ? "" : "s"}) · {queueIds.length} to queue · {unmarkedIds.length} unmarked will be discarded.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">Failed saves stay staged; nothing silently disappears.</p>
          <div className="mt-6 grid gap-2">
            <Button className="min-h-11" onClick={() => void process()}>{`Save ${saveIds.length} · Queue ${queueIds.length} · Discard ${unmarkedIds.length}`}</Button>
            <Button variant="outline" className="min-h-11" onClick={() => setPhase("mark")}>Back to marking</Button>
            <Button variant="ghost" className="min-h-11" onClick={onExit}>Cancel salvage</Button>
          </div>
        </div>
      </div>
    );
  }

  if (items.length === 0) return <div className="grid min-h-0 flex-1 place-items-center px-5 text-center"><div><p className="font-medium">Nothing waiting to salvage.</p><p className="mt-2 text-sm text-muted-foreground">Fetch feeds when you want a fresh batch.</p></div></div>;

  return (
    <div className="jomo-enter flex min-h-[calc(100%-56px)] flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-1 text-[11px] text-muted-foreground">
        <button type="button" onClick={onExit} className="inline-flex items-center gap-1 hover:text-foreground"><Icon name="ChevronLeft" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> exit salvage</button>
        <span className="truncate">{scopeLabel ? `Source: ${scopeLabel}` : "Selected source"}</span>
        <span className="ml-auto font-mono">{items.length} staged · {markedCount} marked ({saveIds.length} save / {queueIds.length} queue)</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-2">
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-2">
          {items.map((item, index) => {
            const mark = marks[item.id];
            return (
              <div key={item.id} ref={(el) => { rowRefs.current[index] = el; }} onClick={() => setFocus(index)} className={index === focus ? "rounded-xl ring-2 ring-primary/90" : "rounded-xl"}>
                <div className={mark === "save" ? "rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-3 py-2.5" : mark === "queue" ? "rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2.5" : "rounded-xl border border-border bg-card px-3 py-2.5"}>
                  <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.sourceColor }} />
                    <span className="min-w-0 truncate font-medium text-foreground/80">{item.source}</span>
                    <span>·</span>
                    <span>{item.time}</span>
                    <span className="ml-auto shrink-0">{KIND_META[item.kind].label}</span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-start justify-between gap-2">
                    {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 break-words line-clamp-2 text-[13px] max-md:pointer-coarse:text-[15px] font-medium leading-5 text-foreground/90">{item.title ?? item.fullName}</a> : <p className="min-w-0 flex-1 break-words line-clamp-2 text-[13px] max-md:pointer-coarse:text-[15px] font-medium leading-5 text-foreground/90">{item.title ?? item.fullName}</p>}
                    <div className="flex shrink-0 gap-1">
                      <button type="button" aria-label={mark === "save" ? "Clear save mark" : "Mark for saving"} title={mark === "save" ? "Clear save mark" : "Mark for saving"} onClick={() => setMark(item.id, mark === "save" ? null : "save")} className={mark === "save" ? "grid size-8 place-items-center rounded-lg bg-emerald-500/20 text-emerald-400 max-md:pointer-coarse:size-9" : "grid size-8 place-items-center rounded-lg border border-border text-muted-foreground hover:border-emerald-500/60 hover:text-foreground max-md:pointer-coarse:size-9"}><Icon name="Star" className={mark === "save" ? "size-4 fill-current max-md:pointer-coarse:size-[18px]" : "size-4 max-md:pointer-coarse:size-[18px]"} /></button>
                      <button type="button" aria-label={mark === "queue" ? "Clear queue mark" : "Mark for queueing"} title={mark === "queue" ? "Clear queue mark" : "Mark for queueing"} onClick={() => setMark(item.id, mark === "queue" ? null : "queue")} className={mark === "queue" ? "grid size-8 place-items-center rounded-lg bg-amber-400/20 text-amber-400 max-md:pointer-coarse:size-9" : "grid size-8 place-items-center rounded-lg border border-border text-muted-foreground hover:border-amber-400/60 hover:text-foreground max-md:pointer-coarse:size-9"}><Icon name="Clock" className="size-4 max-md:pointer-coarse:size-[18px]" /></button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="sticky bottom-0 border-t border-border bg-background/95 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-xs text-muted-foreground backdrop-blur">
        <div className="mx-auto max-w-xl"><Button className="min-h-11 w-full" onClick={() => setPhase("confirm")}>{markedCount === 0 ? "Discard everything" : `Finish (${markedCount} marked)`}</Button></div>
        j/k move · s save · l queue · x clear · o open · unmarked items get discarded after you confirm
      </div>
    </div>
  );
}
import { useEffect, useRef, useState } from "react";
import type { Item, SavedState } from "../item-model";
import { TriageRow } from "./triage-row";

export function TriageView({ items, onOpen, onAction, activeKindLabel }: {
  items: Item[];
  onOpen: (item: Item) => void;
  onAction: (item: Item, state: SavedState) => Promise<void>;
  activeKindLabel: string;
}) {
  const [focus, setFocus] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const apply = async (index: number, state: SavedState) => {
    const item = items[index];
    if (!item || pendingRef.current) return;
    pendingRef.current = true;
    setPendingId(item.id);
    try {
      await onAction(item, state);
      setToast(`"${item.title ?? item.fullName}" → ${state}`);
    } catch (cause) { setToast(cause instanceof Error ? cause.message : "Could not apply that decision."); }
    finally { pendingRef.current = false; setPendingId(null); }
  };


  useEffect(() => { setFocus((current) => Math.min(current, Math.max(0, items.length - 1))); }, [items.length]);
  useEffect(() => { rowRefs.current[focus]?.scrollIntoView?.({ block: "nearest" }); }, [focus]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (pendingRef.current || items.length === 0 || (event.target instanceof HTMLElement && event.target.closest("button, a, input, textarea, [contenteditable]"))) return;
      if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); setFocus((current) => Math.min(items.length - 1, current + 1)); return; }
      if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); setFocus((current) => Math.max(0, current - 1)); return; }
      if (!items[focus]) return;
      if (event.key === "o" || event.key === "Enter") { event.preventDefault(); onOpen(items[focus]); return; }
      const state = event.key === "s" ? "saved" : event.key === "l" ? "later" : event.key === "x" || event.key === "d" ? "dropped" : null;
      if (state) { event.preventDefault(); void apply(focus, state); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, focus, onOpen, onAction]);

  if (items.length === 0) return <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{activeKindLabel === "All" ? "Nothing left to triage." : `No ${activeKindLabel.toLowerCase()} items to triage.`}</p>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 max-h-full flex-1 space-y-1 overflow-y-auto">
      {items.map((item, index) => <TriageRow key={item.id} item={item} focused={index === focus} onOpen={() => onOpen(item)} onSet={(state) => void apply(index, state)} registerRef={(el) => { rowRefs.current[index] = el; }} />)}
      <div className="sticky bottom-0 grid grid-cols-3 gap-2 border-t border-border bg-background/95 py-2 backdrop-blur">
        <button type="button" className="min-h-11 rounded-lg bg-foreground px-2 text-sm text-background disabled:opacity-50" disabled={pendingId !== null} onClick={() => void apply(focus, "saved")}>Save to Library</button>
        <button type="button" className="min-h-11 rounded-lg border border-border px-2 text-sm disabled:opacity-50" disabled={pendingId !== null} onClick={() => void apply(focus, "later")}>Queue for later</button>
        <button type="button" className="min-h-11 rounded-lg px-2 text-sm disabled:opacity-50" disabled={pendingId !== null} onClick={() => void apply(focus, "dropped")}>Discard</button>
      </div>
    </div>
    <p role="status" className="mt-3 border-t border-border py-2 text-xs text-muted-foreground">{toast ?? `${items.length} loaded · j/k move · s save · l queue · x discard · o open`}</p>
  </div>;
}

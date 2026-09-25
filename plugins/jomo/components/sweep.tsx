import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { KIND_META, type Item, type SavedState } from "../item-model";
import { SourceMark } from "./source-mark";
export function SweepView({ items, onOpen, onExit, onAction }: { items: Item[]; onOpen?: (item: Item) => void; onExit: () => void; onAction: (item: Item, state: SavedState) => Promise<void> }) {
  const [index, setIndex] = useState(0);
  const [dx, setDx] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const finished = index >= items.length;
  const item = items[index] as Item;

  const apply = async (state: SavedState, advance = true) => {
    const current = items[index];
    if (!current || actionPendingRef.current) return;
    actionPendingRef.current = true;
    setActionPending(true);
    setToast(state === "saved" ? "Saving article…" : state === "later" ? "Queueing link…" : "Discarding…");
    try { await onAction(current, state); }
    catch (error) { setToast(error instanceof Error ? error.message : "Could not apply that decision."); return; }
    finally { actionPendingRef.current = false; setActionPending(false); }
    setToast(`"${current.title ?? current.fullName}" → ${state}`);
    if (advance) setIndex((i) => i + 1);
  };

  const step = (delta: number) => setIndex((i) => Math.max(0, Math.min(items.length - 1, i + delta)));

  // Sweep keys: space/s ingest, backspace/x/d drop, l later, arrows skip,
  // o read, esc exits the sprint.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, a, input, textarea, [contenteditable]")) return;
      if (event.key === " " || event.key === "s") { event.preventDefault(); apply("saved"); return; }
      if (event.key === "Backspace" || event.key === "d" || event.key === "x") { event.preventDefault(); apply("dropped"); return; }
      if (event.key === "l") { event.preventDefault(); apply("later"); return; }
      if (event.key === "o" || event.key === "Enter") { const current = items[index]; if (current) { event.preventDefault(); if (current.url) window.open(current.url, "_blank", "noopener,noreferrer"); else onOpen?.(current); } return; }
      if (event.key === "ArrowRight") { event.preventDefault(); step(1); return; }
      if (event.key === "ArrowLeft" || event.key === "b") { event.preventDefault(); step(-1); return; }
      if (event.key === "Escape") { event.preventDefault(); onExit(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, index]);

  // Match triage-row gesture ownership: keep intentional 32px edge swipes for
  // BB navigation, but claim horizontal card gestures with a non-passive
  // listener before the app shell can turn them into left-nav drags.
  useEffect(() => {
    const el = articleRef.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let edge = false;
    let offset = 0;
    let claimed = false;
    let pointerId: number | null = null;

    const releasePointer = () => {
      if (pointerId !== null) {
        try { el.releasePointerCapture(pointerId); } catch { /* noop */ }
        pointerId = null;
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY };
      edge = touch.clientX < 32 || touch.clientX > window.innerWidth - 32;
      claimed = false;
      if (!edge) event.stopPropagation();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!start) return;
      const horizontal = event.touches[0].clientX - start.x;
      const vertical = event.touches[0].clientY - start.y;
      offset = Math.abs(horizontal) > Math.abs(vertical) ? Math.max(-160, Math.min(160, horizontal)) : 0;
      if (edge) return;
      if (!claimed && Math.abs(horizontal) > 8 && Math.abs(horizontal) > Math.abs(vertical)) claimed = true;
      if (claimed) { event.preventDefault(); event.stopPropagation(); }
      setDx(offset);
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.type !== "touchcancel" && !edge) {
        if (offset > 130) void apply("saved");
        else if (offset < -130) void apply("dropped");
      }
      start = null;
      edge = false;
      offset = 0;
      claimed = false;
      releasePointer();
      setDx(0);
    };
    const onPointerDown = (event: PointerEvent) => {
      edge = event.clientX < 32 || event.clientX > window.innerWidth - 32;
      if (edge) return;
      pointerId = event.pointerId;
      try { el.setPointerCapture(event.pointerId); } catch { /* already captured */ }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("pointerdown", onPointerDown);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("pointerdown", onPointerDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, index]);

  if (finished) {
    return (
      <div className="jomo-enter grid min-h-0 flex-1 place-items-center px-5">
        <div className="max-w-md text-center">
          <p className="text-3xl max-md:pointer-coarse:text-4xl font-semibold tracking-tight">That is enough for today.</p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{items.length === 0 ? "There was nothing waiting for a decision." : "The rest can wait. There is no score to improve and nothing to catch up on."}</p>
          <Button variant="outline" size="sm" className="mt-7 h-9 max-md:pointer-coarse:h-10" onClick={onExit}>Let the rest wait</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="jomo-enter flex min-h-[calc(100%-56px)] flex-1 flex-col">
      <div className="px-4 pt-1">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <button type="button" onClick={onExit} className="inline-flex items-center gap-1 hover:text-foreground"><Icon name="ChevronLeft" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> exit sweep</button>
          <span className="font-mono">{index + 1} / {items.length}</span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${Math.round(((index + 1) / items.length) * 100)}%` }} />
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <span className="absolute inset-0 grid place-items-center bg-emerald-500/15 text-sm font-medium text-emerald-400" style={{ opacity: dx > 24 ? Math.min(1, dx / 120) : 0 }}>✓ Ingest</span>
        <span className="absolute inset-0 grid place-items-center bg-muted text-sm font-medium text-muted-foreground" style={{ opacity: dx < -24 ? Math.min(1, -dx / 120) : 0 }}>✕ Drop</span>
        <article
          ref={articleRef}
          className="relative flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-border bg-card p-5 max-md:pointer-coarse:p-6 shadow-lg"
          style={{ touchAction: "pan-y", transform: `translateX(${dx}px)` }}
        >
          <div className="flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground">
            <SourceMark item={item} />
            <span className="min-w-0 truncate font-medium text-foreground">{item.source}</span>
            <span>·</span>
            <span>{item.time}</span>
            <span className="ml-auto rounded-full bg-muted px-2 py-0.5">{KIND_META[item.kind].label}</span>
          </div>
          {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-left">
            <h2 className="text-2xl max-md:pointer-coarse:text-3xl font-semibold leading-snug tracking-tight">{item.title ?? item.fullName}</h2>
            {(item.body || item.description) ? <p className="mt-2 line-clamp-3 text-sm max-md:pointer-coarse:text-base leading-6 text-muted-foreground">{item.body || item.description}</p> : null}
          </a> : <button type="button" className="text-left" onClick={() => onOpen?.(item)}>
            <h2 className="text-2xl max-md:pointer-coarse:text-3xl font-semibold leading-snug tracking-tight">{item.title ?? item.fullName}</h2>
            {(item.body || item.description) ? <p className="mt-2 line-clamp-3 text-sm max-md:pointer-coarse:text-base leading-6 text-muted-foreground">{item.body || item.description}</p> : null}
          </button>}
          <div className="flex flex-wrap items-center gap-3 border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
            <span><kbd className="font-mono">space</kbd>/<kbd className="font-mono">s</kbd> ingest & next</span>
            <span><kbd className="font-mono">backspace</kbd> drop</span>
            <span><kbd className="font-mono">l</kbd> later</span>
            <span><kbd className="font-mono">→</kbd> skip</span>
            <span><kbd className="font-mono">o</kbd> read</span>
          </div>
        </article>
      </div>
      <div className="sticky bottom-0 border-t border-border bg-background/95 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-xs text-muted-foreground backdrop-blur">
        <div className="mx-auto mb-2 grid max-w-xl grid-cols-3 gap-2">
          <Button className="min-h-11" disabled={actionPending} onClick={() => void apply("saved")}>{actionPending ? "Working…" : "Save & next"}</Button>
          <Button variant="outline" className="min-h-11" disabled={actionPending} onClick={() => void apply("later")}>Queue for later</Button>
          <Button variant="ghost" className="min-h-11" disabled={actionPending} onClick={() => void apply("dropped")}>Discard</Button>
        </div>
        {toast ?? "space = save & next · backspace = discard · arrows skip · esc exits"}
      </div>
    </div>
  );
}

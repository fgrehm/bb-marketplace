import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { KIND_META, STATE_ACCENT, type Item, type SavedState } from "../item-model";
import { StateButton } from "./state-button";

const STATE_CYCLE: Record<SavedState, SavedState> = { new: "later", later: "saved", saved: "new", dropped: "new" };


export function TriageRow({ item, focused, selected, onOpen, onSet, registerRef }: {
  item: Item;
  focused: boolean;
  selected?: boolean;
  onOpen: () => void;
  onSet: (state: SavedState) => void;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  const [dx, setDx] = useState(0);
  const divRef = useRef<HTMLDivElement | null>(null);

  // Gesture isolation: native, non-passive listeners so preventDefault is
  // honored, stopPropagation keeps the touch away from document-level
  // listeners (the app's left-nav drawer), and pointer capture takes the
  // gesture away from pointer-based handlers. Edge zone (32px) stays with
  // the app nav on purpose.
  useEffect(() => {
    const el = divRef.current;
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
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      offset = Math.abs(dx) > Math.abs(dy) ? Math.max(-140, Math.min(140, dx)) : 0;
      if (edge) return;
      if (!claimed && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) claimed = true;
      if (claimed) { event.preventDefault(); event.stopPropagation(); }
      setDx(offset);
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.type !== "touchcancel" && !edge) {
        if (offset > 110) onSet("saved");
        else if (offset < -110) onSet("dropped");
      }
      offset = 0; start = null; edge = false; claimed = false;
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
  }, [onSet, onOpen]);

  return (
    <div className="relative overflow-hidden rounded-xl">
      <span className="absolute inset-0 grid place-items-center bg-emerald-500/15 text-xs font-medium text-emerald-400" style={{ opacity: dx > 24 ? Math.min(1, dx / 90) : 0 }}>✓ Ingest</span>
      <span className="absolute inset-0 grid place-items-center bg-muted text-xs font-medium text-muted-foreground" style={{ opacity: dx < -24 ? Math.min(1, -dx / 90) : 0 }}>✕ Drop</span>
      <div
        ref={(el) => { divRef.current = el; registerRef(el); }}
        tabIndex={-1}
        onClick={onOpen}
        onFocus={() => undefined}
        style={{ touchAction: "pan-y", transform: `translateX(${dx}px)` }}
        className={cn(
          "relative flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card px-3 max-md:pointer-coarse:px-4 py-2.5 max-md:pointer-coarse:py-3 transition-[border-color,transform,opacity] border-l-4",
          STATE_ACCENT[item.saved],
          focused && "border-transparent bg-muted/60 ring-2 ring-primary/90 shadow-md",
          selected && "ring-2 ring-sky-400/70 border-sky-400/40",
          item.saved === "dropped" && "line-through decoration-muted-foreground/60",
        )}
      >
        <StateButton state={item.saved} onCycle={() => onSet(STATE_CYCLE[item.saved])} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-[11px] max-md:pointer-coarse:text-xs text-muted-foreground">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.sourceColor }} />
            <span className="min-w-0 truncate font-medium text-foreground/80">{item.source}</span>
            <span>·</span>
            <span>{item.time}</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline truncate">{KIND_META[item.kind].label}{item.minutes ? ` · ${item.minutes} min` : item.duration ? ` · ${item.duration}` : ""}</span>
            <span className="ml-auto hidden shrink-0 sm:inline">{item.tags.slice(0, 2).join(" ")}</span>
          </div>
          <p className="mt-0.5 truncate text-[13px] max-md:pointer-coarse:text-[15px] font-medium text-foreground/90">
            {item.title ?? item.fullName ?? item.body}
          </p>
          {item.description ? <p className="mt-0.5 line-clamp-1 text-[12px] text-muted-foreground">{item.description}</p> : (item.kind === "post" || item.kind === "article" || item.kind === "paper") && !item.fullName ? <p className="mt-0.5 line-clamp-1 text-[12px] max-md:pointer-coarse:hidden text-muted-foreground">{item.body}</p> : null}
        </div>
      </div>
    </div>
  );
}

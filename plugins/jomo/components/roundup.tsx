import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing";
import type { Item } from "../item-model";

export function RoundupCard({ items, onOpen }: { items: Item[]; onOpen: (item: Item) => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return <section className="jomo-enter rounded-3xl bg-card/40 px-6 py-12 text-center ring-1 ring-border/40"><Icon name="Check" className="mx-auto size-5 text-emerald-400" /><h2 className="mt-3 text-xl font-medium tracking-tight">All quiet.</h2><button type="button" onClick={() => setDismissed(false)} className="mt-5 text-xs text-muted-foreground underline">Show the report</button></section>;
  return <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-amber-400/[0.07] via-card/70 to-card/40 shadow-sm ring-1 ring-border/50">
    <div className="flex items-center justify-between px-4 pt-3"><p className="text-[11px] font-medium uppercase tracking-[0.16em] text-amber-400">JOMO report</p><button type="button" aria-label="Dismiss roundup" onClick={() => setDismissed(true)} className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS + " grid place-items-center text-muted-foreground hover:text-foreground")}><Icon name="X" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /></button></div>
    <div className="px-4 pb-1"><p className="text-xl font-medium tracking-tight">Nothing is asking for attention.</p><p className="mt-2 text-sm text-muted-foreground">A few items are waiting in RSS review. No recommendations or automatic decisions have been made.</p></div>
    <ul className="mx-2 mt-3 space-y-1 pb-2">{items.slice(0, 3).map((item) => <li key={item.id}><button type="button" onClick={() => onOpen(item)} className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/40"><span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ backgroundColor: item.sourceColor }} /><span className="min-w-0"><span className="block text-[13px] max-md:pointer-coarse:text-[15px] leading-5">{item.title ?? item.fullName}</span><span className="text-[11px] text-muted-foreground">{item.source}</span></span></button></li>)}</ul>
    {items.length === 0 && <p className="px-4 pb-4 text-sm text-muted-foreground">No items waiting here.</p>}
  </section>;
}

import type { Item } from "../item-model";
import { SourceMark } from "./source-mark";
import { ItemFooter } from "./item-footer";

export function ArticleCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <button type="button" className="block p-4 pb-2 text-left" onClick={onOpen}>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <SourceMark item={item} />
          <span className="min-w-0 truncate font-medium text-foreground">{item.source}</span>
          <span>·</span>
          <span className="shrink-0">{item.time}</span>
        </div>
        <h3 className="mt-2.5 text-[15px] max-md:pointer-coarse:text-base font-semibold leading-snug tracking-tight">{item.title}</h3>
        <p className="mt-1.5 line-clamp-2 text-[13px] max-md:pointer-coarse:text-[15px] leading-5 text-muted-foreground">{item.body}</p>
      </button>
      <ItemFooter item={item} onSave={onSave} />
    </article>
  );
}

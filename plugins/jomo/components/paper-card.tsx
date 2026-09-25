import type { Item } from "../item-model";
import { SourceMark } from "./source-mark";
import { ItemFooter } from "./item-footer";

export function PaperCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <button type="button" className="block p-4 pb-2 text-left" onClick={onOpen}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <SourceMark item={item} />
          <span className="font-medium text-foreground">{item.source}</span>
          <span>·</span>
          <span>{item.time}</span>
        </div>
        <h3 className="mt-2.5 text-[15px] font-medium leading-snug tracking-tight">{item.title}</h3>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{item.body}</p>
      </button>
      <ItemFooter item={item} onSave={onSave} isRepoLike />
    </article>
  );
}

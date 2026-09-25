import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import type { Item } from "../item-model";
import { SourceMark } from "./source-mark";
import { ItemFooter } from "./item-footer";

export function VideoCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <button type="button" className={cn("relative block w-full aspect-video max-h-48 bg-gradient-to-br p-5 text-left sm:max-h-56 sm:aspect-auto sm:pb-14", item.thumbAccent)} onClick={onOpen}>
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-11 place-items-center rounded-full bg-background/80 text-background shadow-lg transition-transform group-hover:scale-110">
            <Icon name="Play" className="size-5 translate-x-px fill-current" />
          </span>
        </span>
        <span className="absolute bottom-2 left-3 flex items-center gap-1 font-mono text-[11px] text-foreground/80"><Icon name="Play" className="size-3" /> {item.duration}</span>
        <span className="absolute bottom-2 right-3 text-[11px] text-muted-foreground">{item.views}</span>
      </button>
      <div className="p-4 pb-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <SourceMark item={item} />
          <span className="min-w-0 truncate font-medium text-foreground">{item.source}</span>
          <span>·</span>
          <span className="shrink-0">{item.time}</span>
        </div>
        <h3 className="mt-2.5 text-[15px] font-semibold leading-snug tracking-tight">{item.title}</h3>
      </div>
      <ItemFooter item={item} onSave={onSave} />
    </article>
  );
}

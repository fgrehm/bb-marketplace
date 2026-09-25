import { Icon } from "@/components/ui/icon";
import type { Item } from "../item-model";
import { SourceMark } from "./source-mark";
import { SaveButton } from "./save-button";

export function PostCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <div className="p-4">
        <div className="flex items-start gap-2.5">
          <SourceMark item={item} />
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            <p><span className="font-medium text-foreground">{item.author}</span> <span className="opacity-70">{item.handle}</span></p>
            <p className="mt-0.5">{item.source} · {item.time}</p>
          </div>
          <Icon name="MessageSquare" className="mt-0.5 size-3.5 text-muted-foreground/60" />
        </div>
        <button type="button" className="mt-2.5 block w-full text-left" onClick={onOpen}>
          <p className="text-[13px] leading-6 text-foreground/90">{item.body}</p>
          {item.thread && item.thread.length > 0 && (
            <p className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-primary">{item.thread.length} more in thread <Icon name="ChevronRight" className="size-3" /></p>
          )}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-3 max-md:pointer-coarse:px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center p-1">{item.likes} likes</span>
        <span className="inline-flex items-center p-1">{item.reposts} reposts</span>
        <span className="ml-auto"><SaveButton item={item} onToggle={onSave} /></span>
      </div>
    </article>
  );
}

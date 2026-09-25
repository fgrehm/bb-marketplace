import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { KIND_META, type Item } from "../item-model";
import { SourceMark } from "./source-mark";
import { MarkdownBody } from "../markdown-body";
import { plainExcerpt } from "../excerpt-plain";
import { SaveButton } from "./save-button";

export function Reader({ item, body, loading, onBack, onToggleSaved }: { item: Item; body: string | null; loading: boolean; onBack: () => void; onToggleSaved: () => void }) {
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

        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center justify-between text-sm text-muted-foreground">
            <SaveButton item={item} onToggle={onToggleSaved} />

          </div>
        </div>
      </div>
    </main>
  );
}

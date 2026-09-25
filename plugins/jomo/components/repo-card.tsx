import { Icon } from "@/components/ui/icon";
import type { Item } from "../item-model";
import { SaveButton } from "./save-button";

export function RepoCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <div className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon name="GithubLogo" className="size-4 text-foreground/70" />
          <span className="font-mono font-medium text-foreground">{item.fullName}</span>
          <span className="ml-auto">{item.time}</span>
        </div>
        <button type="button" className="mt-2 block w-full text-left" onClick={onOpen}>
          <p className="text-[13px] leading-5 text-muted-foreground">{item.description}</p>
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-3 max-md:pointer-coarse:px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center p-1">{item.stars} stars</span>
        {item.issues && <span className="inline-flex items-center p-1">{item.issues} open issues</span>}
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: item.langColor }} />
          {item.language}
        </span>
        <span className="ml-auto"><SaveButton item={item} onToggle={onSave} /></span>
      </div>
    </article>
  );
}

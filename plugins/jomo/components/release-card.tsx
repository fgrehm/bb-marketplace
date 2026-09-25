import { Icon } from "@/components/ui/icon";
import type { Item } from "../item-model";
import { SaveButton } from "./save-button";

export function ReleaseCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <div className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon name="GithubLogo" className="size-4 text-foreground/70" />
          <span className="font-mono font-medium text-foreground">{item.fullName}</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{item.version}</span>
          <span className="ml-auto">{item.time}</span>
        </div>
        <button type="button" className="mt-2.5 w-full space-y-1.5 text-left" onClick={onOpen}>
          {item.changes?.map((change) => (
            <p key={change.hash} className="flex items-baseline gap-2 text-[12px]">
              <span className="font-mono text-[10px] text-muted-foreground/70">{change.hash}</span>
              <span className="text-foreground/85">{change.message}</span>
            </p>
          ))}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-3 max-md:pointer-coarse:px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center p-1">{item.stars} stars</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 max-md:pointer-coarse:size-3.5 rounded-full" style={{ backgroundColor: item.langColor }} />
          {item.language}
        </span>
        <span className="ml-auto"><SaveButton item={item} onToggle={onSave} /></span>
      </div>
    </article>
  );
}

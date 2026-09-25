import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing";
import type { Item } from "../item-model";
import { SaveButton } from "./save-button";

export function ItemFooter({ item, onSave, isRepoLike = false }: { item: Item; onSave: () => void; isRepoLike?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-muted-foreground", isRepoLike ? "border-t border-border" : "border-t border-border/70")}>
      <span className="self-center">{item.tags.slice(0, 2).join(" ")}</span>
      <span className="ml-auto flex items-center gap-1">
        <SaveButton item={item} onToggle={onSave} />
        <button type="button" className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, "hover:bg-muted hover:text-foreground")} aria-label="Open item">
          <Icon name="ArrowUpRight" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} />
        </button>
      </span>
    </div>
  );
}

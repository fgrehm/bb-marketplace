import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing";
import type { Item } from "../item-model";

export function SaveButton({ item, onToggle }: { item: Item; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md p-2 hover:bg-muted"
      onClick={onToggle}
      aria-label="Ingest item"
    >
      <Icon name="Star" className={cn(COARSE_POINTER_ICON_SIZE_SHRINK_CLASS, item.saved === "saved" && "fill-current")} />
      <span className="text-[11px] max-md:pointer-coarse:hidden">{item.saved === "saved" ? "Ingested" : item.saved === "later" ? "Later" : "Ingest"}</span>
    </button>
  );
}

import { cn } from "@/lib/utils";
import type { Item } from "../item-model";

export function SourceMark({ item, large = false }: { item: Item; large?: boolean }) {
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-full font-semibold text-white", large ? "size-10 max-md:pointer-coarse:size-12 text-sm" : "size-6 max-md:pointer-coarse:size-8 text-[10px] max-md:pointer-coarse:text-xs")}
      style={{ backgroundColor: item.sourceColor }}
    >
      {item.author.slice(0, 1)}
    </span>
  );
}

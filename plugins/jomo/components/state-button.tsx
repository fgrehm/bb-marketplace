import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { STATE_MARK, type SavedState } from "../item-model";

export function StateButton({ state, onCycle }: { state: SavedState; onCycle: () => void }) {
  const mark = STATE_MARK[state];
  return (
    <button
      type="button"
      aria-label="Triage state"
      onClick={(event) => { event.stopPropagation(); onCycle(); }}
      className={cn("grid size-6 max-md:pointer-coarse:size-8 shrink-0 place-items-center rounded-full border transition-colors", mark.ring)}
    >
      {mark.icon && <Icon name={mark.icon} className="size-3.5 max-md:pointer-coarse:size-4" />}
    </button>
  );
}

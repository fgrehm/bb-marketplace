import type { ComponentType } from "react";

export type UpdateTarget = "models" | "plugins" | "pinned";
export const UpdateActions: ComponentType<{
  updating: UpdateTarget | null;
  onUpdate: (target: UpdateTarget) => void;
}> = ({ updating, onUpdate }) => (
  <div className="flex gap-2">
    <button type="button" disabled={updating !== null} className="rounded-md border border-input px-3 py-1.5 disabled:opacity-50" onClick={() => onUpdate("models")}>{updating === "models" ? "Refreshing..." : "Refresh models"}</button>
    <button type="button" disabled={updating !== null} className="rounded-md border border-input px-3 py-1.5 disabled:opacity-50" onClick={() => onUpdate("plugins")}>{updating === "plugins" ? "Updating..." : "Update extensions"}</button>
    <button type="button" disabled={updating !== null} className="rounded-md border border-input px-3 py-1.5 disabled:opacity-50" onClick={() => onUpdate("pinned")}>{updating === "pinned" ? "Updating pins..." : "Update pinned packages"}</button>
  </div>
);

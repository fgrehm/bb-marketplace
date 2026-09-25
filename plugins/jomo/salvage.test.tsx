// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { SalvageView } from "./components/salvage";
import type { Item } from "./item-model";

vi.mock("@/components/ui/icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

function item(id: string, title: string): Item {
  return { id, kind: "article", source: "Example", sourceColor: "#64748b", author: "", title, body: "An excerpt.", url: `https://example.org/${id}`, time: "9:00", day: "today", tags: [], saved: "new" };
}

async function render(view: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(view); });
  return { container, root: root as Root };
}

describe("SalvageView", () => {
  it("marks save/queue, confirms counts, processes marks, and discards the rest", async () => {
    const items = [item("a", "Alpha"), item("b", "Beta"), item("c", "Gamma")];
    const actions: Array<{ id: string; state: string }> = [];
    let discardedIds: string[] | null = null;
    const view = <SalvageView items={items}
      onAction={async (entry, state) => { actions.push({ id: entry.id, state }); }}
      onDiscardIds={async (ids) => { discardedIds = ids; return ids.length; }}
      onExit={() => undefined} delayMs={0} />;
    const { container, root } = await render(view);

    // Row 1: mark save. Row 2: mark queue. Row 3: leave unmarked.
    const saveButtons = Array.from(container.querySelectorAll("button")).filter((button) => button.getAttribute("aria-label") === "Mark for saving");
    const queueButtons = Array.from(container.querySelectorAll("button")).filter((button) => button.getAttribute("aria-label") === "Mark for queueing");
    expect(saveButtons.length).toBe(3);
    await act(async () => { saveButtons[0]!.click(); });
    await act(async () => { queueButtons[1]!.click(); });
    await act(async () => { Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Finish (2 marked)")!.click(); });

    // Confirm screen shows both counts before anything runs.
    expect(container.textContent).toContain("1 marked to save");
    expect(container.textContent).toContain("1 to queue");
    expect(container.textContent).toContain("1 unmarked will be discarded");
    expect(actions).toEqual([]);

    await act(async () => { Array.from(container.querySelectorAll("button")).find((button) => button.textContent!.startsWith("Save 1"))!.click(); });

    // Marks applied in order, then leftovers discarded by explicit id.
    await act(async () => {});
    await act(async () => {});
    expect(actions).toEqual([{ id: "a", state: "saved" }, { id: "b", state: "later" }]);
    expect(discardedIds).toEqual(["c"]);
    expect(container.textContent).toContain("1 saved to the Library");
    expect(container.textContent).toContain("1 queued");
    expect(container.textContent).toContain("1 discarded");

    root.unmount();
  });

  it("bulk-marks a whole source from its chip", async () => {
    const items = [item("a", "Alpha"), item("b", "Beta"), item("c", "Gamma")].map((entry) => ({ ...entry, sourceId: "src_x", source: "Example" }));
    let discardedIds: string[] | null = null;
    const view = <SalvageView items={items}
      onAction={async () => undefined}
      onDiscardIds={async (ids) => { discardedIds = ids; return ids.length; }}
      onExit={() => undefined} delayMs={0} />;
    const { container, root } = await render(view);

    await act(async () => { Array.from(container.querySelectorAll("button")).find((button) => button.textContent!.includes("Example (0/3)"))!.click(); });
    await act(async () => { Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save all")!.click(); });
    await act(async () => { Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Finish (3 marked)")!.click(); });
    expect(container.textContent).toContain("3 marked to save");
    await act(async () => { Array.from(container.querySelectorAll("button")).find((button) => button.textContent!.startsWith("Save 3"))!.click(); });
    await act(async () => {});
    await act(async () => {});
    expect(discardedIds).toBe(null);
    expect(container.textContent).toContain("0 discarded");

    root.unmount();
  });

  it("keeps failed saves staged instead of discarding them with the leftovers", async () => {
    const items = [item("a", "Alpha"), item("b", "Beta")];
    const view = <SalvageView items={items}
      onAction={async (entry) => { if (entry.id === "a") throw new Error("offline"); }}
      onDiscardIds={async (ids) => ids.length}
      onExit={() => undefined} delayMs={0} />;
    const { container, root } = await render(view);
    const saveButtons = () => Array.from(container.querySelectorAll("button")).filter((button) => button.getAttribute("aria-label") === "Mark for saving");
    await act(async () => { saveButtons()[0]!.click(); });
    await act(async () => { Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Finish (1 marked)")!.click(); });
    await act(async () => { Array.from(container.querySelectorAll("button")).find((button) => button.textContent!.startsWith("Save 1"))!.click(); });
    await act(async () => {});
    await act(async () => {});

    // Alpha failed and stays staged; only Beta is discarded.
    expect(container.textContent).toContain("1 could not be applied and stayed staged");
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("1 discarded");

    root.unmount();
  });
});
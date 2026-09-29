// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("@/components/ui/icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const reviews = [
  {
    id: "review-pending",
    threadId: "thread-pending",
    threadTitle: "Keep feedback on failure",
    projectId: "project-1",
    projectName: "Example project",
    createdAt: 1700000000000,
    target: { type: "uncommitted" },
    fileCount: 5,
    viewedCount: 2,
    pendingCount: 3,
  },
  {
    id: "review-other",
    threadId: "thread-other",
    threadTitle: "Polish the navigation",
    projectId: "project-2",
    projectName: "Another project",
    createdAt: 1700000100000,
    target: { type: "commit", sha: "abcdef0123456789" },
    fileCount: 0,
    viewedCount: 0,
    pendingCount: 0,
  },
];

describe("Recent reviews landing page", () => {
  it("renders snapshot metadata and progress and opens the thread's existing review without refreshing", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        pluginId: "review-workspace",
        rpc: { recentReviews: async () => ({ reviews }) } as any,
      },
    );
    await slot.findByRole("heading", { name: "Recent reviews" });
    const links = await slot.findAllByRole("link", { name: /Open review for/ });
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Open review for Keep feedback on failure",
      "Open review for Polish the navigation",
    ]);
    expect(links[0]?.getAttribute("href")).toBe(
      "/plugins/review-workspace/review/review/thread-pending",
    );
    expect(within(links[0]!).getByText("Example project")).toBeTruthy();
    expect(slot.getByText("3 pending comments")).toBeTruthy();
    expect(slot.getByText("No pending comments")).toBeTruthy();
    expect(slot.getByText("commit abcdef0123")).toBeTruthy();
    expect(slot.getByText("No changed files")).toBeTruthy();
    const progress = slot.getByRole("progressbar", {
      name: "Files viewed for Keep feedback on failure",
    });
    expect(progress.getAttribute("aria-valuenow")).toBe("2");
    expect(progress.getAttribute("aria-valuemax")).toBe("5");
    fireEvent.click(links[0]!);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "review",
      options: { subPath: "review/thread-pending" },
    });
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual([
      "recentReviews",
    ]);
    slot.lifecycle.unmount();
  });

  it("shows loading then an actionable empty state", async () => {
    let finish!: (value: { reviews: never[] }) => void;
    const pending = new Promise<{ reviews: never[] }>((resolve) => {
      finish = resolve;
    });
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: { recentReviews: () => pending } as any,
      },
    );
    expect(slot.getByRole("status").textContent).toContain("Loading reviews");
    expect(slot.queryByText("No recent reviews yet")).toBeNull();
    finish({ reviews: [] });
    await slot.findByText("No recent reviews yet");
    expect(slot.getByText(/Open a thread and choose/)).toBeTruthy();
    expect(slot.queryByRole("status")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows a load error and retries without creating a snapshot", async () => {
    const recentReviews = vi
      .fn()
      .mockRejectedValueOnce(new Error("Server unavailable"))
      .mockResolvedValueOnce({ reviews });
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: { recentReviews } as any,
      },
    );
    expect((await slot.findByRole("alert")).textContent).toContain(
      "Server unavailable",
    );
    expect(slot.queryByText("No recent reviews yet")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Try again" }));
    await slot.findByRole("link", {
      name: "Open review for Keep feedback on failure",
    });
    expect(slot.queryByRole("alert")).toBeNull();
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual([
      "recentReviews",
      "recentReviews",
    ]);
    slot.lifecycle.unmount();
  });

  it("keeps existing rows on reload failure and updates counts on successful reload", async () => {
    const recentReviews = vi
      .fn()
      .mockResolvedValueOnce({ reviews })
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({
        reviews: [{ ...reviews[0], pendingCount: 0, viewedCount: 5 }],
      });
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: { recentReviews } as any,
      },
    );
    await slot.findByText("3 pending comments");
    fireEvent.click(slot.getByRole("button", { name: "Reload list" }));
    await slot.findByRole("alert");
    expect(slot.getByText("3 pending comments")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() =>
      expect(slot.queryByText("3 pending comments")).toBeNull(),
    );
    expect(slot.getByText("No pending comments")).toBeTruthy();
    expect(slot.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "5",
    );
    slot.lifecycle.unmount();
  });
});

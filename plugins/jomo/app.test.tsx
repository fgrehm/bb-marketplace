// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("@/components/ui/icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const profile = {
  answers: { interests: [], research: [], missList: [], savedMeaning: "", autonomy: "" },
  acceptedDrafts: [],
  notebook: "",
  completedAt: 1,
};

function rpcFixture() {
  return {
    onboarding_get: async () => ({ profile }),
    rss_review_list: async () => ({
      items: [{ id: "itm_rss_test", sourceId: "src_test", source: "Example", kind: "article", title: "A saved-for-later story", author: null, excerpt: "Only a feed excerpt.", url: "https://example.org/story", publishedAt: 1790244000 }],
      total: 1,
      allTotal: 1,
      hasMore: false,
      sourceCount: 1,
      sources: [{ id: "src_test", name: "Example", count: 1 }],
      lastFetchedAt: null,
      drainScheduled: 0,
      drainExempt: 1,
    }),
    rss_sync_status: async () => ({ job: null }),
    rss_sources_list: async () => ({ sources: [{ id: "src_test", name: "Example", url: "https://example.org/feed", kind: "rss", color: "#64748b", enabled: true, lastFetchedAt: null }] }),
    rss_action: async () => ({ outcome: "saved" as const }),
    rss_sync_start: async () => ({ jobId: "job_rss", queued: 1 }),
  };
}

describe("JOMO RSS review app", () => {
  it("opens a reader deep link without loading the whole review queue", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const fixture = rpcFixture();
    const row = { id: "itm_rss_test", sourceId: "src_test", source: "Example", sourceColor: "#64748b", kind: "article", author: null, title: "A saved-for-later story", excerpt: "Only a feed excerpt.", url: "https://example.org/story", publishedAt: 1790244000, tags: "[]", state: "new" as const, contentState: "staged", expiresAt: null };
    const slot = renderSlot(app.navPanels[0]!, { subPath: `item/${row.id}` }, { rpc: { ...fixture, item_get: async () => ({ item: row }) } as any });
    expect(await slot.findByRole("heading", { name: row.title })).toBeTruthy();
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "item_get", input: { id: row.id } });
    slot.lifecycle.unmount();
  });

  it("opens a library deep link beyond the first page", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const fixture = rpcFixture();
    const row = { id: "itm_older_library", sourceId: "src_test", source: "Example", sourceColor: "#64748b", kind: "article", author: null, title: "A saved-for-later story", excerpt: "Only a feed excerpt.", url: "https://example.org/story", publishedAt: 1790244000, tags: "[]", state: "saved" as const, contentState: "ready", expiresAt: null };
    const slot = renderSlot(app.navPanels[0]!, { subPath: `library/${row.id}` }, { rpc: { ...fixture, library_list: async () => ({ items: [], hasMore: false }), library_read: async () => ({ body: "Old saved body", missing: false }), item_get: async () => ({ item: row }) } as any });
    expect(await slot.findByRole("heading", { name: row.title })).toBeTruthy();
    expect(await slot.findByText("Old saved body")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("redirects legacy triage/sweep/reservoir deep links to the RSS review hub", async () => {
    const app = await loadPluginApp(() => import("./app"));
    for (const legacy of ["triage", "sweep", "reservoir"]) {
      const slot = renderSlot(app.navPanels[0]!, { subPath: legacy }, { rpc: rpcFixture() as any });
      expect(await slot.findByRole("heading", { name: "RSS review" })).toBeTruthy();
      slot.lifecycle.unmount();
    }
  });

  it("uses the real RSS review queue on the home report without polling feeds", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpcFixture() as any });
    await vi.waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "rss_review_list", input: { offset: 0 } }));
    expect(await slot.findByText("A saved-for-later story")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Browse the hoard" })).toBeNull();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "rss_sync_start")).toBe(false);
    slot.lifecycle.unmount();
  });


  it("offers no bulk chips in triage and applies decisions one at a time", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const fixture = rpcFixture();
    const action = vi.fn(async () => ({ outcome: "discarded" }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { ...fixture, rss_review_list: async () => ({ items: Array.from({ length: 3 }, (_, index) => ({ id: `itm_bulk_${index}`, source: "Example", kind: "article", title: `Bulk ${index}`, author: null, excerpt: "Preview", url: `https://example.org/${index}`, publishedAt: 1790244000 - index })), total: 3, hasMore: false, sourceCount: 1, lastFetchedAt: null, drainScheduled: 0, drainExempt: 0 }), rss_action: action } as any });
    (await slot.findByRole("button", { name: "RSS review" })).click();
    await slot.findByText("Bulk 0");
    // Bulk batching now lives only in Salvage; triage is strictly per-item.
    expect(slot.queryByText("Bulk by source (loaded items):")).toBeNull();
    expect(slot.queryByRole("button", { name: /Save all/ })).toBeNull();
    slot.getByRole("button", { name: "Discard" }).click();
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith({ id: "itm_bulk_0", action: "discard" });
    slot.lifecycle.unmount();
  });

  it("filters RSS review by source and scopes Salvage to that source", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const fixture = rpcFixture();
    const sourceRows = [
      { id: "itm_example", sourceId: "src_test", source: "Example", kind: "article", title: "Example story", author: null, excerpt: "Preview", url: "https://example.org/story", publishedAt: 1790244000 },
      { id: "itm_other", sourceId: "src_other", source: "Other", kind: "article", title: "Other story", author: null, excerpt: "Preview", url: "https://other.org/story", publishedAt: 1790243000 },
    ];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { ...fixture, rss_review_list: async ({ sourceId }: { sourceId?: string }) => ({
      items: sourceId ? sourceRows.filter((row) => row.sourceId === sourceId) : sourceRows,
      total: sourceId ? 1 : 2,
      allTotal: 2,
      hasMore: false,
      sourceCount: 2,
      sources: [{ id: "src_test", name: "Example", count: 1 }, { id: "src_other", name: "Other", count: 1 }],
      lastFetchedAt: null,
      drainScheduled: 0,
      drainExempt: 2,
    }) } as any });
    (await slot.findByRole("button", { name: "RSS review" })).click();
    await slot.findByText("Example story");
    (await slot.findByRole("button", { name: "Other (1)" })).click();
    await vi.waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "rss_review_list", input: { offset: 0, sourceId: "src_other" } }));
    expect(await slot.findByText("Other story")).toBeTruthy();
    expect(slot.queryByText("Example story")).toBeNull();
    expect(await slot.findByRole("button", { name: "Salvage this source" })).toBeTruthy();
    (await slot.findByRole("button", { name: "Salvage this source" })).click();
    await vi.waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "feed", options: { subPath: "rss/salvage" } }));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "rss_review_list" && (call.input as { sourceId?: string }).sourceId === "src_test")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("persists triage decisions and never treats a failed save as success", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { ...rpcFixture(), rss_action: async () => { throw new Error("Extraction failed"); } } as any });
    (await slot.findByRole("button", { name: "RSS review" })).click();
    await slot.findByText("A saved-for-later story");
    slot.getByRole("button", { name: "Save to Library" }).click();
    await vi.waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "rss_action", input: { id: "itm_rss_test", action: "save" } }));
    expect(slot.getByText("A saved-for-later story")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("queues a pasted link and toggles a persisted source without a feed fetch", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { ...rpcFixture(), queue_link: async () => ({ added: true }), rss_source_set_enabled: async () => ({ saved: true }) } as any });
    (await slot.findByRole("button", { name: "Open JOMO menu" })).click();
    (await slot.findByRole("button", { name: /Sources & links/ })).click();
    (await slot.findByRole("switch", { name: "Toggle Example" })).click();
    await vi.waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "rss_source_set_enabled", input: { id: "src_test", enabled: false } }));
    const field = slot.getByLabelText(/Paste a URL to add to LINKS.md/);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "https://example.org/queued");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    (await slot.findByRole("button", { name: /Queue link/ })).click();
    await vi.waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "queue_link", input: { url: "https://example.org/queued" } }));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "rss_sync_start")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("uses the same persisted sources drawer from RSS review", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpcFixture() as any });
    (await slot.findByRole("button", { name: "RSS review" })).click();
    (await slot.findByRole("button", { name: "Manage sources" })).click();
    expect(await slot.findByRole("switch", { name: "Toggle Example" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("routes the RSS sweep through a panel subPath", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const Panel = app.navPanels[0]!.component;
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpcFixture() as any });
    (await slot.findByRole("button", { name: "RSS review" })).click();
    (await slot.findByRole("button", { name: "Sweep all sources (one at a time)" })).click();
    await vi.waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "feed", options: { subPath: "rss/sweep" } }));
    slot.lifecycle.rerender(<Panel subPath="rss/sweep" />);
    expect(await slot.findByRole("heading", { name: "RSS sweep" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("sweeps staged RSS entries and routes queue decisions through the persisted action", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpcFixture() as any });
    (await slot.findByRole("button", { name: "RSS review" })).click();
    await slot.findByText("A saved-for-later story");
    slot.getByRole("button", { name: "Sweep all sources (one at a time)" }).click();
    await slot.findByText("1 / 1");
    expect(await slot.findByRole("heading", { name: "A saved-for-later story" })).toBeTruthy();
    slot.getByRole("button", { name: "Queue for later" }).click();
    await vi.waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({ method: "rss_action", input: { id: "itm_rss_test", action: "queue" } });
    });
    expect(await slot.findByText("That is enough for today.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("triages a staged row via SQLite without fetching feeds", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpcFixture() as any });
    (await slot.findByRole("button", { name: "RSS review" })).click();
    await slot.findByText("A saved-for-later story");
    slot.getByRole("button", { name: "Discard" }).click();
    await vi.waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "rss_action", input: { id: "itm_rss_test", action: "discard" } }));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "rss_sync_start")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("does not skip older pages after a persisted decision", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const fixture = rpcFixture();
    const paged = {
      ...fixture,
      rss_review_list: async ({ offset }: { offset: number }) => ({
        items: offset === 0 ? Array.from({ length: 25 }, (_, i) => ({ id: `itm_${i}`, source: "Example", kind: "article", title: `Story ${i}`, author: null, excerpt: "Preview", url: `https://example.org/${i}`, publishedAt: 1790244000 - i })) : [{ id: "older", source: "Example", kind: "article", title: "Older story", author: null, excerpt: "Preview", url: "https://example.org/older", publishedAt: 1790243900 }],
        total: 26, hasMore: offset === 0, sourceCount: 1, lastFetchedAt: null,
      }),
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: paged as any });
    (await slot.findByRole("button", { name: "RSS review" })).click();
    await slot.findByText("Story 0");
    slot.getAllByRole("button", { name: "Discard" })[0].click();
    await vi.waitFor(() => expect(slot.queryByText("Story 0")).toBeNull());
    slot.getByRole("button", { name: "Show older entries" }).click();
    await vi.waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "rss_review_list", input: { offset: 24 } }));
    slot.lifecycle.unmount();
  });

  it("keeps a failed persisted decision in the review queue", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { ...rpcFixture(), rss_action: async () => { throw new Error("Save failed"); } } as any });
    (await slot.findByRole("button", { name: "RSS review" })).click();
    await slot.findByText("A saved-for-later story");
    slot.getByRole("button", { name: "Save to Library" }).click();
    await slot.findByRole("alert");
    expect(slot.getByText("A saved-for-later story")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("keeps refresh explicit and exposes the article save action on the phone surface", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpcFixture() as any });

    (await slot.findByRole("button", { name: "RSS review" })).click();
    await slot.findByRole("heading", { name: "RSS review" });
    await slot.findByText("A saved-for-later story");
    expect(slot.inspection.rpcCalls.some((call) => call.method === "rss_sync_start")).toBe(false);
    slot.getByRole("button", { name: "Fetch feeds now" }).click();
    await vi.waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({ method: "rss_sync_start", input: {} });
    });

    slot.getByRole("button", { name: "Save to Library" }).click();
    await vi.waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({ method: "rss_action", input: { id: "itm_rss_test", action: "save" } });
    });
    expect(await slot.findByText("Saved to Library.")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("bring in links screen", () => {
  it("routes to a dedicated ingestion screen with live progress", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const Panel = app.navPanels[0]!.component;
    const fixture = { ...rpcFixture(), queue_preview: async () => ({ queued: 3 }), queue_status: async () => ({ job: { id: "j1", type: "links" as const, status: "running" as const, queued: 3, processed: 1, ingested: 1, alreadyPresent: 0, failures: [], failedCount: 0, remaining: null, error: null, log: [{ url: "https://example.org/a", outcome: "saved" as const, preview: false }, { url: "https://example.org/b", outcome: "failed" as const, preview: false, reason: "HTTP 403" }], currentUrl: "https://example.org/c" } }) } as any;
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: fixture });
    (await slot.findByRole("button", { name: "Bring in links" })).click();
    await vi.waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "feed", options: { subPath: "links/ingest" } }));
    slot.lifecycle.rerender(<Panel subPath="links/ingest" />);
    expect(await slot.findByText(/Working: 1 of 3/)).toBeTruthy();
    expect(await slot.findByText(/1 saved · 0 preview bookmarks · 0 failed/)).toBeTruthy();
    expect(await slot.findByText(/now: example.org/)).toBeTruthy();
    expect(await slot.findByText(/failed \(HTTP 403\)/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows one follow-up CTA after a completed ingestion run", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const fixture = { ...rpcFixture(), queue_preview: async () => ({ queued: 13 }), queue_status: async () => ({ job: { id: "j1", type: "links" as const, status: "completed" as const, queued: 24, processed: 24, ingested: 11, alreadyPresent: 0, failures: [], failedCount: 0, remaining: 13, error: null, log: Array.from({ length: 11 }, (_, index) => ({ url: `https://example.org/${index}`, outcome: "saved" as const, preview: false })), currentUrl: null } }) } as any;
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: fixture });
    (await slot.findByRole("button", { name: "Bring in links" })).click();
    expect(await slot.findByText("13 links still waiting")).toBeTruthy();
    expect(await slot.findByRole("button", { name: "Bring in 13 links" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Bring in 13 more" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Bring in all 13 links" })).toBeNull();
    slot.lifecycle.unmount();
  });
});

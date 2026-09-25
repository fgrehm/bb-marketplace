import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { LibrarianDesk } from "./librarian-desk";
import { plainExcerpt } from "./excerpt-plain";
import { NotebookPanel, Onboarding, type LibrarianProfile } from "./onboarding";
import type { rpcContract } from "./server";
import "./jomo.css";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { type Item, type SavedState } from "./item-model";
import { toItem } from "./item-projection";
import { Reader } from "./components/reader";
import { RoundupCard } from "./components/roundup";
import { SourcesDrawer } from "./components/sources-drawer";
import { RssReview } from "./components/rss-review";
import { LinksIngest } from "./components/links-ingest";
import { type Source } from "./source-model";
import { toRssItem } from "./rss-item";

type MainView = "home" | "library";
const MAIN_VIEWS = new Set<string>(["home", "library"]);

const LEGACY_SCREENS: Record<string, string> = { triage: "rss", sweep: "rss", reservoir: "rss" };
function parseScreen(subPath?: string): string {
  const raw = (subPath ?? "").replace(/^\/+|\/+$/g, "");
  try { const screen = decodeURIComponent(raw) || "home"; return LEGACY_SCREENS[screen] ?? screen; } catch { return "home"; }
}

function JomoPage({ subPath }: { subPath?: string }) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [profile, setProfile] = useState<LibrarianProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileReload, setProfileReload] = useState(0);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [screen, setScreen] = useState(() => parseScreen(subPath));
  const lastScreen = useRef<MainView>("home");
  const internalNavigation = useRef(false);
  useEffect(() => { setScreen(parseScreen(subPath)); }, [subPath]);
  const goTo = (next: string, replace = false) => {
    if (MAIN_VIEWS.has(screen)) lastScreen.current = screen as MainView;
    internalNavigation.current = true;
    setScreen(next);
    navigate.toPluginPanel("feed", { subPath: next === "home" ? "" : next, ...(replace ? { replace: true } : {}) });
  };
  const goBack = (fallback: string) => {
    if (internalNavigation.current) { window.history.back(); setScreen(fallback); }
    else goTo(fallback, true);
  };
  const libraryOpen = screen === "library" || screen.startsWith("library/");
  const librarySelected = screen.startsWith("library/") ? screen.slice("library/".length) : null;
  const rssOpen = screen === "rss";
  const rssSweeping = screen === "rss/sweep";
  const rssSalvaging = screen === "rss/salvage";
  const linksIngestOpen = screen === "links/ingest";
  const deskOpen = screen === "desk";
  const [libraryOffset, setLibraryOffset] = useState(0);
  const [libraryRows, setLibraryRows] = useState<Array<{ id: string; source: string; kind: string; title: string; excerpt: string; url: string | null; publishedAt: number; contentState: string }>>([]);
  const [libraryHasMore, setLibraryHasMore] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [interviewOpen, setInterviewOpen] = useState(false);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [appError, setAppError] = useState<string | null>(null);
  const [dataReload, setDataReload] = useState(0);
  const [sources, setSources] = useState<Source[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [readerBody, setReaderBody] = useState<string | null>(null);
  const [deepItem, setDeepItem] = useState<Item | null>(null);
  const [itemMissing, setItemMissing] = useState(false);
  const [readerLoading, setReaderLoading] = useState(false);


  useEffect(() => {
    let cancelled = false;
    void rpc.call("rss_sources_list", {}).then(({ sources: rows }) => {
      if (cancelled) return;
      setSources(rows.map((row) => ({ ...row, kind: row.kind as Source["kind"], lastFetch: row.lastFetchedAt ? new Date(row.lastFetchedAt * 1000).toLocaleDateString() : "not fetched" })));
    }).catch((cause: unknown) => { if (!cancelled) setAppError(cause instanceof Error ? cause.message : "Could not load sources."); });
    return () => { cancelled = true; };
  }, [rpc, dataReload]);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("rss_review_list", { offset: 0 }).then(({ items: rows }) => {
      if (cancelled) return;
      setItems(rows.map(toRssItem));
    }).catch((cause: unknown) => {
      if (!cancelled) setAppError(cause instanceof Error ? cause.message : "Could not load the review queue.");
    });
    return () => { cancelled = true; };
  }, [rpc, dataReload]);

  useEffect(() => {
    if (!utilityOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUtilityOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [utilityOpen]);

  useEffect(() => {
    let cancelled = false;
    setProfileLoaded(false);
    setProfileError(null);
    void rpc.call("onboarding_get", {}).then(({ profile: stored }) => {
      if (!cancelled) {
        setProfile(stored);
        setProfileLoaded(true);
      }
    }).catch((cause: unknown) => {
      if (!cancelled) {
        setProfileError(cause instanceof Error ? cause.message : "The librarian could not open its notebook.");
        setProfileLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [profileReload, rpc]);

  useEffect(() => {
    if (!libraryOpen) return;
    let cancelled = false;
    setLibraryBusy(true);
    setLibraryError(null);
    void rpc.call("library_list", { offset: libraryOffset }).then(({ items: rows, hasMore }) => {
      if (!cancelled) {
        setLibraryRows((previous) => libraryOffset ? [...previous, ...rows] : rows);
        setLibraryHasMore(hasMore);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setLibraryError(error instanceof Error ? error.message : "Could not load library.");
    }).finally(() => { if (!cancelled) setLibraryBusy(false); });
    return () => { cancelled = true; };
  }, [libraryOpen, libraryOffset, rpc]);


  const openLibrary = () => {
    setLibraryRows([]);
    setLibraryOffset(0);
    goTo("library");
  };

  const completeOnboarding = async (next: LibrarianProfile) => {
    await rpc.call("onboarding_save", next);
    setProfile(next);
    setInterviewOpen(false);
  };

  const saveNotebook = async (notebook: string) => {
    const result = await rpc.call("notebook_save", { notebook });
    if (result.saved) setProfile((current) => current ? { ...current, notebook } : current);
  };

  const itemId = screen.startsWith("item/") ? screen.slice(5) : screen.startsWith("library/") ? screen.slice("library/".length) : null;
  const activeItem = useMemo(() => items.find((item) => item.id === itemId) ?? (deepItem?.id === itemId ? deepItem : null), [itemId, items, deepItem]);

  useEffect(() => {
    if (!itemId || items.some((item) => item.id === itemId)) return;
    let cancelled = false;
    setItemMissing(false);
    void rpc.call("item_get", { id: itemId }).then(({ item }) => {
      if (cancelled) return;
      setDeepItem(item ? toItem(item) : null);
      setItemMissing(!item);
    }).catch(() => { if (!cancelled) setItemMissing(true); });
    return () => { cancelled = true; };
  }, [itemId, items, rpc]);

  useEffect(() => {
    setReaderBody(null);
    if (!activeItem || (activeItem.contentState !== "ready" && activeItem.saved !== "saved")) { setReaderLoading(false); return; }
    let cancelled = false;
    setReaderLoading(true);
    void rpc.call("library_read", { id: activeItem.id }).then(({ body }) => { if (!cancelled) setReaderBody(body); }).catch(() => undefined).finally(() => { if (!cancelled) setReaderLoading(false); });
    return () => { cancelled = true; };
  }, [activeItem, rpc]);

  const openItem = (item: Item) => goTo(`item/${item.id}`);
  const closeReader = () => goBack(lastScreen.current);

  const actOn = async (item: Item, state: SavedState) => {
    if (state === "new") throw new Error("Restoring a decision is not available yet");
    const action = state === "saved" ? "save" : state === "later" ? "queue" : "discard";
    const { outcome } = await rpc.call("rss_action", { id: item.id, action });
    if (outcome === "already_present") throw new Error("Already in Library. Discard this duplicate to clear it.");
    setItems((current) => current.filter((entry) => entry.id !== item.id));
  };
  const toggleSaved = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    if (item) void actOn(item, "saved").catch((cause: unknown) => setAppError(cause instanceof Error ? cause.message : "Could not save item."));
  };

  const flashNotice = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? null : current)), 3600);
  };

  const showNotice = (text: string) => {
    if (drawerOpen) { flashNotice(text); return; }
    setNotice(null);
  };

  const toggleSource = (id: string) => {
    const source = sources.find((row) => row.id === id);
    if (!source) return;
    void rpc.call("rss_source_set_enabled", { id, enabled: !source.enabled }).then(({ saved }) => { if (saved) setDataReload((value) => value + 1); }).catch((cause: unknown) => setAppError(cause instanceof Error ? cause.message : "Could not update source."));
  };

  const addFeed = async (name: string, url: string) => {
    const { added } = await rpc.call("rss_source_add", { name, url });
    setDataReload((value) => value + 1);
    showNotice(added ? `Added "${name}" paused. Enable it only when ready.` : "That feed is already configured.");
  };

  const ingestLink = async (rawUrl: string) => {
    const { added } = await rpc.call("queue_link", { url: rawUrl });
    showNotice(added ? "Queued in LINKS.md. Bring in links to save it." : "Already in LINKS.md.");
  };

  const hoardLinks = async (urls: string[]) => {
    for (const url of urls) await rpc.call("queue_link", { url });
  };

  if (!profileLoaded) return <div className="grid h-full place-items-center bg-background text-sm text-muted-foreground">Waking the librarian…</div>;

  if (profileError && !setupDismissed) {
    return <div className="grid h-full place-items-center bg-background px-5"><div className="max-w-md rounded-2xl border border-border bg-card p-6 text-center"><Icon name="AlertCircle" className="mx-auto size-6 text-amber-400" /><h2 className="mt-3 text-lg font-semibold">The librarian could not open its notebook.</h2><p className="mt-2 text-sm text-muted-foreground">{profileError}</p><div className="mt-5 flex justify-center gap-2"><Button onClick={() => setProfileReload((current) => current + 1)}>Try again</Button><Button variant="outline" onClick={() => setSetupDismissed(true)}>Continue without it</Button></div></div></div>;
  }

  if (interviewOpen || (!profile && !setupDismissed)) {
    return <Onboarding onComplete={completeOnboarding} onSkip={() => { setSetupDismissed(true); setInterviewOpen(false); }} />;
  }

  if (rssOpen || rssSweeping || rssSalvaging) return <RssReview onClose={() => { goBack(lastScreen.current); setDataReload((value) => value + 1); }} onManageSources={() => { goBack(lastScreen.current); setDrawerOpen(true); }} sweeping={rssSweeping} onSweepChange={(next) => { if (MAIN_VIEWS.has(screen)) lastScreen.current = screen as MainView; setScreen(next ? "rss/sweep" : "rss"); navigate.toPluginPanel("feed", { subPath: next ? "rss/sweep" : "rss" }); }} salvaging={rssSalvaging} onSalvageChange={(next) => { if (MAIN_VIEWS.has(screen)) lastScreen.current = screen as MainView; setScreen(next ? "rss/salvage" : "rss"); navigate.toPluginPanel("feed", { subPath: next ? "rss/salvage" : "rss" }); }} />;

  if (linksIngestOpen) return <LinksIngest onClose={() => goBack(lastScreen.current)} />;

  if (libraryOpen) {
    if (librarySelected) {
      // One reader for RSS items and Library articles: library/<id> reuses
      // the same deep-load path (item_get + library_read) as item/<id>.
      if (activeItem) return <Reader key={activeItem.id} item={activeItem} body={readerBody} loading={readerLoading} onBack={() => goBack("library")} onToggleSaved={() => { if (activeItem.saved === "new" || activeItem.saved === "later") toggleSaved(activeItem.id); }} />;
      return <div className="grid h-full place-items-center bg-background px-5 text-center text-sm text-muted-foreground">{itemMissing ? <div><p>This article is no longer available.</p><Button variant="outline" className="mt-4" onClick={() => goBack("library")}>Back to library</Button></div> : "Opening article…"}</div>;
    }
    return <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-5 py-4"><Button variant="outline" onClick={() => goBack(lastScreen.current)}>Back to JOMO</Button><h1 className="text-lg font-semibold">Library</h1></header>
      <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-5 py-6">
        {libraryError && <p role="alert" className="mb-4 text-sm text-red-400">{libraryError}</p>}
        <>{libraryRows.length === 0 && !libraryBusy && <p className="text-sm text-muted-foreground">Nothing saved here yet.</p>}{libraryRows.map((row) => <button key={row.id} type="button" onClick={() => goTo(`library/${row.id}`)} className="block w-full border-b border-border py-4 text-left hover:bg-muted/40"><span className="text-xs text-muted-foreground">{row.source} · {new Date(row.publishedAt * 1000).toLocaleDateString()}</span><strong className="mt-1 block">{row.title}</strong><span className="mt-1 block line-clamp-2 text-sm text-muted-foreground">{plainExcerpt(row.excerpt)}</span></button>)}{libraryBusy && <p className="py-4 text-sm text-muted-foreground">Loading library…</p>}{libraryHasMore && !libraryBusy && <Button className="mt-5" variant="outline" onClick={() => setLibraryOffset((value) => value + 50)}>Show more</Button>}</>
      </div>
    </div>;
  }

  if (deskOpen) return <LibrarianDesk items={items} onClose={() => goBack(lastScreen.current)} onOpenItem={(id) => { const item = items.find((entry) => entry.id === id); if (item) openItem(item); }} onHoardLinks={hoardLinks} onSubscribe={addFeed} />;

  if (itemId && !activeItem) return <div className="grid h-full place-items-center bg-background px-5 text-center text-sm text-muted-foreground">{itemMissing ? <div><p>This item is no longer available.</p><Button variant="outline" className="mt-4" onClick={closeReader}>Back to JOMO</Button></div> : "Opening item…"}</div>;
  if (activeItem) return <Reader key={activeItem.id} item={activeItem} body={readerBody} loading={readerLoading} onBack={closeReader} onToggleSaved={() => toggleSaved(activeItem.id)} />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b border-border px-3 max-sm:pointer-coarse:px-4 py-3 max-sm:pointer-coarse:py-4 sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">jomo</h1>
            <p className="hidden sm:block text-xs text-muted-foreground">The queue is resting. Nothing needs attention.</p>
          </div>
          <div className="relative flex items-center gap-2">
            <button type="button" aria-expanded={utilityOpen} aria-label="Open JOMO menu" onClick={() => setUtilityOpen((current) => !current)} className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS + " grid place-items-center rounded-full bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground")}><Icon name="Explore" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /></button>
            {utilityOpen && <><button type="button" aria-label="Close JOMO menu" className="fixed inset-0 z-30 cursor-default" onClick={() => setUtilityOpen(false)} /><div className="jomo-enter absolute right-12 top-11 z-40 w-60 rounded-2xl bg-card p-1.5 shadow-xl ring-1 ring-border/60"><button type="button" onClick={() => { setUtilityOpen(false); goTo("desk"); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-foreground hover:bg-muted"><Icon name="MessageSquare" className="size-4 text-amber-400" /> Talk to the librarian</button><button type="button" onClick={() => { setUtilityOpen(false); setDrawerOpen(true); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><Icon name="Plus" className="size-4" /> Sources & links</button><button type="button" onClick={() => { setUtilityOpen(false); if (profile) setNotebookOpen(true); else setInterviewOpen(true); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><Icon name="Explore" className="size-4" /> {profile ? "Librarian's notebook" : "Meet the librarian"}</button></div></>}
            <Button variant="outline" size="sm" className="h-8 max-md:pointer-coarse:h-10" onClick={() => navigate.toCompose()}><Icon name="GridView" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> <span className="hidden sm:inline">Back to BB</span></Button>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto w-full max-w-5xl px-3 max-sm:pointer-coarse:px-4 py-4 sm:px-8 sm:py-6">
          <section className="jomo-enter mx-auto max-w-3xl py-5 sm:py-12">
            {appError && <p role="alert" className="mb-4 text-sm text-red-400">{appError}</p>}
            <RoundupCard items={items.filter((item) => !item.sourceId || sources.some((source) => source.id === item.sourceId && source.enabled))} onOpen={openItem} />
            <div className="mt-12 text-center">
              <p className="text-sm text-muted-foreground">The rest of the round is waiting in RSS review.</p>
              <p className="mt-1 text-xs text-muted-foreground/70">No badge, no deadline, no need to catch up.</p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Button onClick={() => goTo("desk")}><Icon name="MessageSquare" className="size-4" /> Talk to the librarian</Button>
                <Button variant="outline" onClick={openLibrary}>Library</Button>
                <Button variant="outline" onClick={() => goTo("links/ingest")}>Bring in links</Button>
                <Button variant="outline" onClick={() => goTo("rss")}>RSS review</Button>
              </div>
            </div>
          </section>
        </div>
      </div>
      {profile && <NotebookPanel profile={profile} open={notebookOpen} onClose={() => setNotebookOpen(false)} onSave={saveNotebook} onReinterview={() => { setNotebookOpen(false); setInterviewOpen(true); }} />}
      <SourcesDrawer
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setNotice(null); }}
        sources={sources}
        onToggle={toggleSource}
        onAddFeed={addFeed}
        onIngest={ingestLink}
        notice={notice}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "jomo", title: "JOMO", icon: "Leaf", path: "feed", component: JomoPage });
});

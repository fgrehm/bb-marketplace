import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { SOURCE_KIND_META, inferKindFromUrl, type Source } from "../source-model";

export function SourcesDrawer({ open, onClose, sources, onToggle, onAddFeed, onIngest, notice }: {
  open: boolean;
  onClose: () => void;
  sources: Source[];
  onToggle: (id: string) => void;
  onAddFeed: (name: string, url: string) => Promise<void>;
  onIngest: (url: string) => Promise<void>;
  notice: string | null;
}) {
  const [tab, setTab] = useState<"links" | "feeds">("links");
  const [feedName, setFeedName] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const feedLooksValid = feedUrl.includes(".") && !feedUrl.includes(" ");
  const linkLooksValid = linkUrl.includes(".") && !linkUrl.includes(" ");
  const queueLink = () => { void onIngest(linkUrl).then(() => { setLinkUrl(""); setError(null); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not queue link.")); };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const inference = linkLooksValid ? inferKindFromUrl(linkUrl) : null;

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close panel" className="absolute inset-0 bg-background/60 backdrop-blur-sm" onClick={onClose} />
      <aside className="jomo-enter absolute inset-x-0 bottom-0 max-h-[82%] overflow-y-auto rounded-t-2xl border border-border bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:inset-y-0 sm:right-0 sm:left-auto sm:top-0 sm:h-full sm:max-h-full sm:w-96 sm:rounded-t-none sm:rounded-l-2xl sm:pb-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Sources</h2>
          <button type="button" onClick={onClose} aria-label="Close" className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS + " grid place-items-center hover:bg-muted")}><Icon name="X" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /></button>
        </div>

        <div className="mt-4 inline-flex rounded-lg border border-border p-0.5">
          {([["links", "Queue a link"], ["feeds", "Add a feed"]] as Array<["links" | "feeds", string]>).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={cn("rounded-md px-3 py-1.5 text-xs transition-colors", tab === id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>{label}</button>
          ))}
        </div>

        {notice && <p className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">{notice}</p>}
        {error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}

        {tab === "links" ? (
          <div className="mt-4">
            <label className="text-xs text-muted-foreground" htmlFor="jomo-ingest-url">Paste a URL to add to LINKS.md. It is not fetched until you bring in links.</label>
            <div className="mt-2 flex gap-2">
              <input
                id="jomo-ingest-url"
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && linkLooksValid) { event.preventDefault(); queueLink(); } }}
                placeholder="https://…"
                className="h-10 flex-1 rounded-lg border border-border bg-card text-sm max-md:pointer-coarse:!text-base outline-none placeholder:text-muted-foreground/50 focus:border-primary"
              />
              <Button size="sm" className="h-10" disabled={!linkLooksValid} onClick={queueLink}>
                <Icon name="Plus" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> Queue link
              </Button>
            </div>
            {inference && <p className="mt-2 text-xs text-muted-foreground">Will queue a <span className="font-medium text-foreground">{inference.label}</span> · no fetch now</p>}
          </div>
        ) : (
          <div className="mt-4">
            <label className="text-xs text-muted-foreground" htmlFor="jomo-feed-url">New feed — give it a display name and the feed URL</label>
            <div className="mt-2 flex flex-col gap-2">
              <input
                id="jomo-feed-url"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
                placeholder="https://example.com/feed.xml"
                className="h-10 rounded-lg border border-border bg-card px-3 text-sm max-md:pointer-coarse:!text-base outline-none placeholder:text-muted-foreground/50 focus:border-primary"
              />
              <input
                value={feedName}
                onChange={(event) => setFeedName(event.target.value)}
                placeholder="Optional display name"
                className="h-10 rounded-lg border border-border bg-card px-3 text-sm max-md:pointer-coarse:!text-base outline-none placeholder:text-muted-foreground/50 focus:border-primary"
              />
              <Button size="sm" className="h-10" disabled={!feedLooksValid} onClick={() => { try { void onAddFeed(feedName || new URL(feedUrl).hostname, feedUrl).then(() => { setFeedUrl(""); setFeedName(""); setError(null); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not add feed.")); } catch { setError("Enter a valid feed URL."); } }}>
                <Icon name="Plus" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> Add feed
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">The feed is fetched once now to validate it, then starts paused. Fetching content is always explicit in RSS review.</p>
          </div>
        )}

        <h3 className="mt-6 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Configured · {sources.filter((source) => source.enabled).length} active / {sources.length}</h3>
        <div className="mt-2 space-y-1">
          {sources.map((source) => {
            const kindMeta = SOURCE_KIND_META[source.kind];
            return (
              <div key={source.id} className={cn("flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 hover:bg-muted/40", !source.enabled && "opacity-55")}>
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: source.color }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] max-md:pointer-coarse:text-[15px] font-medium">{source.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground"><Icon name={kindMeta.icon} className="inline size-3" /> {kindMeta.label} · {source.lastFetch}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={source.enabled}
                  aria-label={`Toggle ${source.name}`}
                  onClick={() => onToggle(source.id)}
                  className={cn("h-5 max-md:pointer-coarse:h-7 w-9 shrink-0 rounded-full p-0.5 transition-colors", source.enabled ? "bg-primary" : "bg-muted-foreground/40")}
                >
                  <span className={cn("block size-4 max-md:pointer-coarse:size-6 rounded-full bg-background transition-transform", source.enabled && "translate-x-4 max-md:pointer-coarse:translate-x-2")} />
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

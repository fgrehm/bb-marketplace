import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { type Item, type SavedState } from "../item-model";
import { toRssItem, type RssReviewRow } from "../rss-item";
import { TriageView } from "./triage";
import { SweepView } from "./sweep";
import { SalvageView } from "./salvage";
import type { rpcContract } from "../server";

type RssSyncJob = { id: string; status: "running" | "completed" | "failed" | "interrupted"; queued: number; processed: number; staged: number; duplicates: number; failures: Array<{ source: string; reason: string }>; failedCount: number; error: string | null };

export function RssReview({ onClose, onManageSources, sweeping, onSweepChange, salvaging, onSalvageChange }: { onClose: () => void; onManageSources: () => void; sweeping: boolean; onSweepChange: (sweeping: boolean) => void; salvaging: boolean; onSalvageChange: (salvaging: boolean) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<RssReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sourceCount, setSourceCount] = useState(0);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [drainScheduled, setDrainScheduled] = useState(0);
  const [drainExempt, setDrainExempt] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [sweepRows, setSweepRows] = useState<RssReviewRow[]>([]);
  const [salvageRows, setSalvageRows] = useState<RssReviewRow[]>([]);
  const [sweepLoading, setSweepLoading] = useState(false);
  const [salvageBusy, setSalvageBusy] = useState(false);
  const [job, setJob] = useState<RssSyncJob | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([rpc.call("rss_review_list", { offset: 0 }), rpc.call("rss_sync_status", {})]).then(([result, status]) => {
      if (cancelled) return;
      setRows(result.items);
      setNextOffset(result.items.length);
      setTotal(result.total);
      setSourceCount(result.sourceCount);
      setLastFetchedAt(result.lastFetchedAt);
      setHasMore(result.hasMore);
      setDrainScheduled(result.drainScheduled);
      setDrainExempt(result.drainExempt);
      setJob(status.job);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not open RSS review.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rpc, reload]);

  useEffect(() => {
    if (job?.status !== "running") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void rpc.call("rss_sync_status", {}).then(({ job: current }) => {
        if (cancelled || !current) return;
        setJob(current);
        if (current.status !== "running") setReload((value) => value + 1);
      }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not check feed progress."); });
    }, 1800);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [job?.status, rpc]);

  const loadAllRows = async (): Promise<RssReviewRow[]> => {
    const first = await rpc.call("rss_review_list", { offset: 0 });
    const allRows = [...first.items];
    let offset = first.items.length;
    let more = first.hasMore;
    while (more && offset < first.total) {
      const page = await rpc.call("rss_review_list", { offset });
      if (!page.items.length) break;
      allRows.push(...page.items);
      offset += page.items.length;
      more = page.hasMore;
    }
    return allRows;
  };

  const startSweep = async (navigateAfter = true) => {
    if (sweepLoading || job?.status === "running" || total === 0) return;
    setSweepLoading(true);
    setError(null);
    try {
      setSweepRows(await loadAllRows());
      if (navigateAfter) onSweepChange(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not prepare the RSS sweep."); }
    finally { setSweepLoading(false); }
  };

  const startSalvage = async (navigateAfter = true) => {
    if (sweepLoading || job?.status === "running" || total === 0) return;
    setSweepLoading(true);
    setError(null);
    try {
      setSalvageRows(await loadAllRows());
      if (navigateAfter) onSalvageChange(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not prepare the salvage batch."); }
    finally { setSweepLoading(false); }
  };

  useEffect(() => {
    if (sweeping && !loading && total > 0 && sweepRows.length === 0 && !sweepLoading) void startSweep(false);
    if (salvaging && !loading && total > 0 && salvageRows.length === 0 && !sweepLoading) void startSalvage(false);
  // startSweep/startSalvage are invoked only on entry to a deep-linked pass, not after a decision.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweeping, salvaging, loading, total, sweepRows.length, salvageRows.length]);

  const actionForState = (state: SavedState): "save" | "queue" | "discard" => {
    if (state === "saved") return "save";
    if (state === "later") return "queue";
    if (state === "dropped") return "discard";
    throw new Error("That RSS decision is not available");
  };

  const startSync = async () => {
    setError(null);
    try {
      await rpc.call("rss_sync_start", {});
      const { job: current } = await rpc.call("rss_sync_status", {});
      setJob(current);
      if (current?.status !== "running") setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start feed refresh."); }
  };

  const actOn = async (item: Item, state: SavedState) => {
    if (busyId) return;
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      const { outcome } = await rpc.call("rss_action", { id: item.id, action: actionForState(state) });
      if (outcome === "already_present") throw new Error("Already in Library. Discard this duplicate to clear it.");
      setRows((current) => current.filter((row) => row.id !== item.id));
      setNextOffset((current) => Math.max(0, current - 1));
      setTotal((current) => Math.max(0, current - 1));
      setNotice(outcome === "saved" ? "Saved to Library." : outcome === "queued" ? "Added to LINKS.md for later." : outcome === "already_queued" ? "It was already waiting in LINKS.md." : "Discarded. It will not return on the next refresh.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not apply that review action."); throw cause; }
    finally { setBusyId(null); }
  };

  const showMore = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("rss_review_list", { offset: nextOffset });
      setRows((current) => [...current, ...result.items]);
      setNextOffset((current) => current + result.items.length);
      setHasMore(result.hasMore);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more articles."); }
    finally { setLoading(false); }
  };

  if (sweeping) return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="border-b border-border px-4 py-3 sm:px-8 sm:py-4"><div className="mx-auto flex max-w-3xl items-center gap-3"><Button variant="outline" onClick={() => { onSweepChange(false); setReload((value) => value + 1); }}>Back to RSS review</Button><div className="min-w-0"><h1 className="text-lg font-semibold">RSS sweep</h1><p className="text-xs text-muted-foreground">Each choice applies immediately. Save fetches the article page.</p></div></div></header>
    <SweepView items={sweepRows.map(toRssItem)} onExit={() => { onSweepChange(false); setReload((value) => value + 1); }} onAction={actOn} />
  </div>;

  if (salvaging) return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="border-b border-border px-4 py-3 sm:px-8 sm:py-4"><div className="mx-auto flex max-w-3xl items-center gap-3"><Button variant="outline" disabled={salvageBusy} onClick={() => { onSalvageChange(false); setReload((value) => value + 1); }}>{salvageBusy ? "Processing…" : "Back to RSS review"}</Button><div className="min-w-0"><h1 className="text-lg font-semibold">Salvage</h1><p className="text-xs text-muted-foreground">Mark what is worth keeping, then process the batch once.</p></div></div></header>
    <SalvageView items={salvageRows.map(toRssItem)} onExit={() => { onSalvageChange(false); setReload((value) => value + 1); }} onAction={actOn} onDiscardIds={async (ids) => (await rpc.call("rss_discard_ids", { ids })).discarded} onBusyChange={setSalvageBusy} />
  </div>;

  return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-8 sm:py-4"><Button variant="outline" onClick={onClose}>Back to JOMO</Button><div className="min-w-0 flex-1"><h1 className="text-lg font-semibold">RSS review</h1><p className="hidden text-xs text-muted-foreground sm:block">A quiet queue, only fetched when you ask.</p></div><Button disabled={job?.status === "running" || sourceCount === 0} onClick={() => void startSync()}>{job?.status === "running" ? "Fetching…" : "Fetch feeds now"}</Button></header>
    <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-5 pb-[env(safe-area-inset-bottom)] sm:px-8 sm:py-7">
      <div className="mb-5 rounded-2xl border border-border bg-card p-4 text-sm"><p>{total} waiting · {sourceCount} active source{sourceCount === 1 ? "" : "s"}{lastFetchedAt ? ` · last fetched ${new Date(lastFetchedAt * 1000).toLocaleString()}` : " · never fetched"}</p><p className="mt-1 text-xs text-muted-foreground">Feed excerpts stay here. Saving fetches the article page; queueing adds only its URL to LINKS.md. Nothing is fetched in the background.</p>
        <p className="mt-1 text-xs text-muted-foreground">{drainScheduled} newly staged drain after 30 days unreviewed · {drainExempt} older entries never drain.</p>
        <Button className="mt-3 w-full" disabled={total === 0 || job?.status === "running" || sweepLoading} onClick={() => void startSalvage(true)}>{sweepLoading ? "Preparing…" : "Salvage (mark, then process once)"}</Button>
        <Button variant="outline" className="mt-2 w-full" disabled={total === 0 || job?.status === "running" || sweepLoading} onClick={() => void startSweep(true)}>{sweepLoading ? "Preparing sweep…" : "Sweep the queue (one at a time)"}</Button>
        <Button variant="ghost" className="mt-2" onClick={onManageSources}>Manage sources</Button>
        {job && <p role="status" className="mt-3 text-xs text-muted-foreground">{job.status === "running" ? `Fetching ${job.processed} of ${job.queued} feeds · ${job.staged} new · ${job.failures.length} recent failures` : job.status === "completed" ? `Last refresh finished · ${job.staged} staged · ${job.duplicates} already seen · ${job.failedCount} feeds failed` : job.status === "interrupted" ? "Last refresh was interrupted. You can start another when ready." : job.status === "failed" ? "Last refresh stopped with an error." : ""}{job.error && <span className="block text-red-400">{job.error}</span>}{job.failures.map((failure) => <span key={`${failure.source}:${failure.reason}`} className="mt-1 block text-red-400">{failure.source}: {failure.reason}</span>)}</p>}
      </div>
      {notice && <p role="status" className="mb-4 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
      {loading && rows.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">Opening the review queue…</p>}
      {!loading && rows.length === 0 && <div className="rounded-2xl border border-dashed border-border px-5 py-12 text-center"><p className="font-medium">Nothing waiting.</p><p className="mt-2 text-sm text-muted-foreground">Fetch feeds when you want a fresh batch. Deciding can wait.</p></div>}
      <TriageView items={rows.map(toRssItem)} activeKindLabel="All" onOpen={(item) => { if (item.url) window.open(item.url, "_blank", "noopener,noreferrer"); }} onAction={actOn} />
      {hasMore && <Button variant="outline" className="mt-4 w-full" disabled={loading} onClick={() => void showMore()}>{loading ? "Loading…" : "Show older entries"}</Button>}
    </main>
  </div>;
}

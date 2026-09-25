import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "../server";

type IngestEvent = { url: string; outcome: "saved" | "already_present" | "failed"; preview: boolean; reason?: string };
type QueueJob = { id: string; status: "running" | "completed" | "failed" | "interrupted"; queued: number; processed: number; ingested: number; alreadyPresent: number; failedCount: number; remaining: number | null; error: string | null; log: IngestEvent[]; currentUrl: string | null };

function domain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/**
 * Bring in links: a dedicated ingestion screen with a live progress bar,
 * per-item log, cancel, and a persisted job so reloads land back on the
 * same run. Nothing is fetched until Start is pressed.
 */
export function LinksIngest({ onClose }: { onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [queued, setQueued] = useState<number | null>(null);
  const [job, setJob] = useState<QueueJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One poll in flight at a time: overlapping responses can otherwise land
  // out of order and a stale "running" status would outlive a newer
  // "completed" one.
  const pollInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([rpc.call("queue_preview", {}), rpc.call("queue_status", {})]).then(([preview, status]) => {
      if (cancelled) return;
      setQueued(preview.queued);
      setJob(status.job);
    }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not open the links queue."); });
    return () => { cancelled = true; };
  }, [rpc]);

  useEffect(() => {
    if (job?.status !== "running") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      void Promise.all([rpc.call("queue_status", {}), rpc.call("queue_preview", {})]).then(([status, preview]) => {
        if (cancelled) return;
        setJob(status.job);
        setQueued(preview.queued);
      }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load progress."); })
        .finally(() => { pollInFlight.current = false; });
    }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [job?.status, rpc]);

  const start = async () => {
    if (busy || job?.status === "running" || !queued) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("queue_start", {});
      const status = await rpc.call("queue_status", {});
      setJob(status.job);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start ingestion."); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (busy || job?.status !== "running") return;
    setBusy(true);
    try { await rpc.call("queue_cancel", {}); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel."); }
    finally { setBusy(false); }
  };

  const running = job?.status === "running";
  const done = job !== null && job.status !== "running";
  const savedFull = job?.log.filter((event) => event.outcome === "saved" && !event.preview).length ?? 0;
  const savedPreview = job?.log.filter((event) => event.outcome === "saved" && event.preview).length ?? 0;
  const percent = job && job.queued > 0 ? Math.round((job.processed / job.queued) * 100) : 0;

  return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="border-b border-border px-4 py-3 sm:px-8 sm:py-4"><div className="mx-auto flex max-w-3xl items-center gap-3"><Button variant="outline" onClick={onClose}>Back to JOMO</Button><div className="min-w-0"><h1 className="text-lg font-semibold">Bring in links</h1><p className="text-xs text-muted-foreground">{queued ?? "…"} link{(queued ?? 0) === 1 ? "" : "s"} waiting in LINKS.md. Saving fetches each page once; nothing runs in the background.</p></div></div></header>
    <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-5 pb-[env(safe-area-inset-bottom)] sm:px-8 sm:py-7">
      {error && <p role="alert" className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}

      {running && <section className="mb-6">
        <p className="text-lg font-semibold">Working: {job.processed} of {job.queued}</p>
        <p className="mt-1 text-xs text-muted-foreground">{savedFull} saved · {savedPreview} preview bookmarks · {job.failedCount} failed{job.currentUrl ? ` · now: ${domain(job.currentUrl)}` : ""}</p>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} /></div>
        <ul className="mt-4 space-y-1 text-sm">
          {job.log.map((event, index) => (
            <li key={`${event.url}:${index}`} className={event.outcome === "failed" ? "text-red-400" : event.preview ? "text-muted-foreground" : "text-foreground/80"}>
              {event.outcome === "failed" ? "✗" : event.preview ? "◐" : "✓"} {domain(event.url)} → {event.outcome === "failed" ? `failed (${event.reason})` : event.preview ? "preview bookmark" : event.outcome === "already_present" ? "already in Library" : "saved"}
            </li>
          ))}
          {job.currentUrl && <li className="text-muted-foreground/70">⋯ {domain(job.currentUrl)} (working…)</li>}
        </ul>
        <Button variant="outline" className="mt-5" disabled={busy} onClick={() => void cancel()}>Cancel run</Button>
        <p className="mt-3 text-xs text-muted-foreground">Leaving this screen keeps the run going; reopen or reload to see progress again.</p>
      </section>}

      {done && <section className="mb-6 rounded-2xl border border-border bg-card p-5">
        <p className="text-lg font-semibold">{job.status === "completed" ? "Finished." : job.status === "interrupted" ? "Run interrupted." : "Run stopped with an error."}</p>
        <p className="mt-2 text-sm text-muted-foreground">{savedFull} saved · {savedPreview} preview bookmarks · {job.alreadyPresent} already in Library · {job.failedCount} failed (they stay in FAILED with reasons).</p>
        {job.error && <p className="mt-2 text-sm text-red-400">{job.error}</p>}
        {job.log.filter((event) => event.outcome === "failed").length > 0 && <ul className="mt-4 space-y-1 text-xs text-red-400">{job.log.filter((event) => event.outcome === "failed").map((event, index) => <li key={`${event.url}:${index}`}>{domain(event.url)}: {event.reason}</li>)}</ul>}
        {queued !== null && queued > 0 && <Button className="mt-5" disabled={busy || running} onClick={() => void start()}>{busy ? "Starting…" : `Bring in ${queued} more`}</Button>}
      </section>}

      {!running && (queued === null || queued === 0) && !done && <p className="py-12 text-center text-sm text-muted-foreground">{queued === 0 ? "Nothing waiting in LINKS.md. Paste links in the sources drawer to queue them." : "Opening the links queue…"}</p>}

      {!running && queued !== null && queued > 0 && <section className="rounded-2xl border border-border bg-card p-5">
        <p className="text-sm text-muted-foreground">{queued} link{queued === 1 ? "" : "s"} waiting in LINKS.md. Successful links move to the Library; failures land in FAILED with their reasons; preview bookmarks are saved when a page only allows share-preview access.</p>
        <Button className="mt-4" disabled={busy || running} onClick={() => void start()}>{busy ? "Starting…" : `Bring in all ${queued} links`}</Button>
      </section>}
    </main>
  </div>;
}
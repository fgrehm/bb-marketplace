import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ArchiveThread, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const THREADS_CHANGED = "bulk-archive.threads-changed";

type AgeFilter = "all" | "7d" | "30d" | "90d";

function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function ageLabel(timestamp: number) {
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  return days === 0 ? "today" : days === 1 ? "1 day old" : `${days} days old`;
}

function ageThreshold(filter: AgeFilter) {
  if (filter === "all") return 0;
  return Number(filter.slice(0, -1)) * 86_400_000;
}

function BulkArchivePage() {
  const rpc = useRpc<typeof rpcContract>();
  const [threads, setThreads] = useState<ArchiveThread[] | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; kind: "personal" | "standard" }>>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [age, setAge] = useState<AgeFilter>("all");
  const [oldestFirst, setOldestFirst] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("threads_list", { projectId });
      setThreads(result.threads as ArchiveThread[]);
      setProjects(result.projects);
      setSelected((current) => new Set([...current].filter((id) => result.threads.some((thread) => thread.id === id))));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load threads.");
    }
  }, [projectId, rpc]);

  useEffect(() => { void load(); }, [load]);
  useRealtime(THREADS_CHANGED, load);

  const filteredThreads = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const threshold = ageThreshold(age);
    return (threads ?? [])
      .filter((thread) => {
        const lastActivity = Math.max(thread.latestAttentionAt, thread.updatedAt);
        return (!normalizedQuery || thread.title.toLowerCase().includes(normalizedQuery))
          && (!threshold || Date.now() - lastActivity >= threshold);
      })
      .sort((a, b) => {
        const aActivity = Math.max(a.latestAttentionAt, a.updatedAt);
        const bActivity = Math.max(b.latestAttentionAt, b.updatedAt);
        return oldestFirst ? aActivity - bActivity : bActivity - aActivity;
      });
  }, [age, oldestFirst, query, threads]);

  const allVisibleSelected = filteredThreads.length > 0 && filteredThreads.every((thread) => selected.has(thread.id));
  const toggleThread = (threadId: string) => {
    setConfirming(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId); else next.add(threadId);
      return next;
    });
  };
  const selectVisible = () => {
    setConfirming(false);
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filteredThreads.forEach((thread) => next.delete(thread.id));
      else filteredThreads.forEach((thread) => next.add(thread.id));
      return next;
    });
  };
  const archive = async () => {
    if (!confirming) { setConfirming(true); return; }
    setArchiving(true);
    try {
      const result = await rpc.call("threads_archive", { threadIds: [...selected] });
      const failed = result.failures.length;
      setNotice(`Archived ${result.archivedThreadIds.length} thread${result.archivedThreadIds.length === 1 ? "" : "s"}${failed ? `; ${failed} failed.` : "."}`);
      setSelected(new Set());
      setConfirming(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to archive the selected threads.");
    } finally {
      setArchiving(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-y-auto pb-28">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Bulk archive</h1>
            <p className="mt-1 text-sm text-muted-foreground">Select inactive threads, then archive them together.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void load()} aria-label="Refresh threads">
            <Icon name="SlidersHorizontal" className="size-4" />
          </Button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search threads" aria-label="Search threads" />
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto"
            value={projectId ?? ""}
            onChange={(event) => { setProjectId(event.target.value || null); setSelected(new Set()); setConfirming(false); }}
            aria-label="Filter by project"
          >
            <option value="">All projects</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.kind === "personal" ? " (Personal)" : ""}</option>)}
          </select>
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5" aria-label="Minimum inactivity">
          {(["all", "7d", "30d", "90d"] as AgeFilter[]).map((option) => (
            <Button key={option} size="sm" variant={age === option ? "secondary" : "outline"} className="shrink-0" onClick={() => setAge(option)}>
              {option === "all" ? "Any activity" : `Idle ${option}+`}
            </Button>
          ))}
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setOldestFirst((current) => !current)} aria-label={`Sort ${oldestFirst ? "newest" : "oldest"} first`}>
            <Icon name="SlidersHorizontal" className="size-4" />
            {oldestFirst ? "Oldest first" : "Newest first"}
          </Button>
        </div>
      </header>

      <section className="px-4 py-4 sm:px-6">
        {error && <p role="alert" className="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="mb-3 rounded-md bg-primary/10 p-3 text-sm text-foreground">{notice}</p>}
        {threads === null ? <p className="py-10 text-center text-sm text-muted-foreground">Loading threads...</p> : filteredThreads.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">No active threads match these filters.</p>
        ) : (
          <>
            <label className="mb-2 flex min-h-11 items-center gap-3 px-1 text-sm font-medium">
              <Checkbox checked={allVisibleSelected} onCheckedChange={selectVisible} aria-label="Select all visible threads" />
              Select visible <span className="font-normal text-muted-foreground">({filteredThreads.length})</span>
            </label>
            <ul className="overflow-hidden rounded-lg border border-border bg-card">
              {filteredThreads.map((thread) => <ThreadRow key={thread.id} thread={thread} selected={selected.has(thread.id)} onToggle={() => toggleThread(thread.id)} />)}
            </ul>
          </>
        )}
      </section>

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg">
          <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm"><strong>{selected.size}</strong> thread{selected.size === 1 ? "" : "s"} selected</p>
            <div className="flex gap-2">
              {confirming && <Button variant="outline" onClick={() => setConfirming(false)} disabled={archiving}>Cancel</Button>}
              <Button variant="destructive" className="flex-1 sm:flex-none" onClick={() => void archive()} disabled={archiving}>
                <Icon name="Archive" className="size-4" />
                {archiving ? "Archiving..." : confirming ? `Archive ${selected.size} threads` : "Archive selected"}
              </Button>
            </div>
          </div>
          {confirming && <p className="mx-auto mt-2 max-w-3xl text-xs text-muted-foreground">This also archives child threads of selected parents.</p>}
        </div>
      )}
    </main>
  );
}

function ThreadRow({ thread, selected, onToggle }: { thread: ArchiveThread; selected: boolean; onToggle: () => void }) {
  const lastActivity = Math.max(thread.latestAttentionAt, thread.updatedAt);
  return (
    <li className={cn("border-b border-border last:border-0", selected && "bg-primary/5")}>
      <label className="flex min-h-20 cursor-pointer items-start gap-3 p-3 active:bg-muted/60">
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${thread.title}`} className="mt-1" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{thread.title}</span>
          <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>Last turn {relativeTime(lastActivity)}</span>
            <span aria-hidden="true">·</span>
            <span>{thread.projectName}</span>
            <span aria-hidden="true">·</span>
            <span>{ageLabel(thread.createdAt)}</span>
            {thread.environmentName && <><span aria-hidden="true">·</span><span className="truncate">{thread.environmentName}</span></>}
          </span>
          {(thread.status !== "idle" || thread.hasPendingInteraction) && <span className="mt-1 inline-block text-xs text-primary">{thread.hasPendingInteraction ? "Needs input" : thread.status === "active" ? "Running" : thread.status}</span>}
        </span>
      </label>
    </li>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "archive",
    title: "Bulk archive",
    description: "Select and archive multiple inactive threads.",
    component: BulkArchivePage,
  });
});

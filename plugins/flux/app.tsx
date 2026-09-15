import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@/components/ui/coarse-pointer-sizing";

type ItemKind = "article" | "video" | "post" | "repo" | "release" | "paper";

type Feed = "all" | "articles" | "videos" | "social" | "code" | "saved";

type SavedState = "new" | "later" | "saved" | "dropped";

type Item = {
  id: string;
  kind: ItemKind;
  source: string;
  sourceColor: string;
  author: string;
  title?: string;
  body: string;
  time: string;
  day: "today" | "yesterday";
  tags: string[];
  saved: SavedState;
  /* article extras */
  minutes?: number;
  /* video extras */
  duration?: string;
  views?: string;
  thumbAccent?: string;
  /* post extras */
  handle?: string;
  thread?: string[];
  likes?: string;
  reposts?: string;
  /* repo / release extras */
  fullName?: string;
  description?: string;
  stars?: string;
  language?: string;
  langColor?: string;
  issues?: string;
  version?: string;
  changes?: Array<{ hash: string; message: string }>;
};

const KIND_META: Record<ItemKind, { label: string; icon: React.ComponentProps<typeof Icon>["name"] }> = {
  article: { label: "Article", icon: "FileText" },
  video: { label: "Video", icon: "Play" },
  post: { label: "Post", icon: "MessageSquare" },
  repo: { label: "Repo", icon: "GithubLogo" },
  release: { label: "Release", icon: "GitBranch" },
  paper: { label: "Paper", icon: "Beaker" },
};

const STATE_MARK: Record<SavedState, { icon: null | React.ComponentProps<typeof Icon>["name"]; ring: string; dot: string }> = {
  new: { icon: null, ring: "border ring-muted-foreground/40", dot: "" },
  later: { icon: "Clock", ring: "bg-amber-400/15 border-amber-400/60 text-amber-400", dot: "" },
  saved: { icon: "Check", ring: "bg-emerald-500/15 border-emerald-500/60 text-emerald-400", dot: "" },
  dropped: { icon: "X", ring: "bg-muted border-transparent text-muted-foreground", dot: "" },
};

const STATE_ACCENT: Record<SavedState, string> = {
  new: "",
  later: "border-l-amber-400",
  saved: "border-l-emerald-500",
  dropped: "border-l-transparent opacity-45",
};

const ITEMS: Item[] = [
  {
    id: "mayfly-chat",
    kind: "article",
    source: "exe.dev",
    sourceColor: "#0ea5e9",
    author: "exe.dev",
    title: "Mayfly Chat: Transient Chat for Agents",
    body: "Chat sessions that evaporate. Why persistence belongs to artifacts, not to conversation — and what an ephemeral-by-default interface changes about how you prompt.",
    time: "17:46",
    day: "today",
    tags: ["#AI", "#agents"],
    saved: "new",
    minutes: 9,
  },
  {
    id: "sqlite-reads",
    kind: "video",
    source: "SQLite",
    sourceColor: "#0f766e",
    author: "fetalsai",
    title: "How SQLite balances read concurrency on a single write lock, visually",
    body: "A step-by-step animation through WAL index pages, shared-memory segments, and the exact instant a checkpoint stalls a reader.",
    time: "16:20",
    day: "today",
    tags: ["#databases", "#systems"],
    saved: "later",
    duration: "28:41",
    views: "412K views",
    thumbAccent: "from-teal-500/30 via-sky-600/10 to-transparent",
  },
  {
    id: "post-agent-backlog",
    kind: "post",
    source: "informal.social",
    sourceColor: "#7c3aed",
    author: "Renata Campos",
    handle: "@renata@informal.social",
    body: "Hot take: your agent's backlog is the backlog. Every idea it triages for you should live in the same place as your real work, not in a private todo file it re-reads every session.",
    time: "15:02",
    day: "today",
    tags: ["#agents", "#process"],
    saved: "new",
    likes: "1.2K",
    reposts: "231",
    thread: [
      "The failure mode isn't forgetting. The agent always re-reads the file. The failure mode is you forgetting the file exists — without an inbox flow, triage never happens.",
      "So: shared, human-visible, boring. A feed is fine. A file is fine. Slacking it into Discord at 2am is not.",
    ],
  },
  {
    id: "repo-lexical",
    kind: "repo",
    source: "GitHub",
    sourceColor: "#3f3f46",
    author: "facebook/lexical",
    body: "",
    time: "13:30",
    day: "today",
    tags: ["#editor", "#react"],
    saved: "new",
    fullName: "facebook/lexical",
    description: "Lexical is an extensible text editor framework that provides reliability, accessibility, and performance on the web.",
    stars: "21.4k",
    language: "TypeScript",
    langColor: "#3178c6",
    issues: "612",
  },
  {
    id: "agentic-ux",
    kind: "article",
    source: "The Pragmatic Engineer",
    sourceColor: "#f59e0b",
    author: "Gergely Orosz",
    title: "What happens when your workspace gets an agent",
    body: "A field guide to products that put context, conversation, and action in the same room — and the two patterns that survive contact with real users.",
    time: "12:41",
    day: "today",
    tags: ["#AI", "#product"],
    saved: "saved",
    minutes: 8,
  },
  {
    id: "release-sdk",
    kind: "release",
    source: "GitHub",
    sourceColor: "#3f3f46",
    author: "get-bb/plugin-sdk",
    body: "",
    time: "11:15",
    day: "today",
    tags: ["#SDK", "#plugins"],
    saved: "new",
    fullName: "get-bb/plugin-sdk",
    stars: "980",
    language: "TypeScript",
    langColor: "#3178c6",
    version: "v0.4.87",
    changes: [
      { hash: "a3f21c9", message: "slots: register nav panels with stable ordering keys" },
      { hash: "7d0e5b1", message: "app: expose toCompose() navigation from panel slots" },
      { hash: "c41aa02", message: "types: shim vaul + portal radix families for app bundles" },
      { hash: "e908cdf", message: "fix: release host RPC tokens on plugin disable" },
    ],
  },
  {
    id: "paper-inboxless",
    kind: "paper",
    source: "arXiv",
    sourceColor: "#b91c1c",
    author: "anon. et al.",
    title: "Inboxless: Read-It-Later Queues as Shared State Between Humans and Agents",
    body: "We evaluate 42 knowledge workers using a shared item queue where both the human and an assistant mutate item state concurrently, finding 3.1× faster triage vs. human-only queues.",
    time: "10:55",
    day: "today",
    tags: ["#HCI", "#agents"],
    saved: "new",
    minutes: 34,
  },
  {
    id: "trinitron",
    kind: "article",
    source: "Hackaday",
    sourceColor: "#84cc16",
    author: "Hackaday",
    title: "After 6 Years as Road Ornament, a Widescreen Sony Trinitron Lives Again",
    body: "A CRT rescued from a front lawn, re-capped, degaussed, and reunited with a PS2. The flyback survived; the hoarder instinct did not.",
    time: "17:00",
    day: "yesterday",
    tags: ["#repair", "#CRT"],
    saved: "new",
    minutes: 5,
  },
  {
    id: "video-esp32",
    kind: "video",
    source: "YouTube",
    sourceColor: "#dc2626",
    author: "Bitluni",
    title: "Booted Linux 6.11 on the ESP32-S3 — full walkthrough with a few tweaks",
    body: "16 MB of flash, two tricks for low memory, and a serial console that's surprisingly tolerable.",
    time: "12:30",
    day: "yesterday",
    tags: ["#linux", "#ESP32"],
    saved: "new",
    duration: "19:07",
    views: "98K views",
    thumbAccent: "from-slate-500/30 via-slate-700/10 to-transparent",
  },
  {
    id: "post-nitter",
    kind: "post",
    source: "fosstodon.org",
    sourceColor: "#059669",
    author: "Lars Wirzenius",
    handle: "@liw@fosstodon.org",
    body: "Nitter is dead (again). Let's pour one out for the scrape-frontends; they were the last way to read that place without an account.",
    time: "12:49",
    day: "yesterday",
    tags: ["#web", "#twitter"],
    saved: "later",
    likes: "892",
    reposts: "154",
  },
  {
    id: "repo-flux",
    kind: "repo",
    source: "GitHub",
    sourceColor: "#3f3f46",
    author: "fgrehm/bb-marketplace",
    body: "",
    time: "09:12",
    day: "yesterday",
    tags: ["#plugins", "#BB"],
    saved: "saved",
    fullName: "fgrehm/bb-marketplace",
    description: "Independently installable BB plugins: Flux, Review Workspace, favicon, and friends.",
    stars: "143",
    language: "TypeScript",
    langColor: "#3178c6",
    issues: "3",
  },
  {
    id: "kottke-spice",
    kind: "article",
    source: "kottke.org",
    sourceColor: "#18a999",
    author: "Jason Kottke",
    title: "Pumpkin Spice Is Dead",
    body: "A casket company has entered the pumpkin spice discourse, which may be the final sign of the flavor's terminal decline. RIP PSL 2003–2026.",
    time: "13:59",
    day: "yesterday",
    tags: ["#culture", "#coffee"],
    saved: "new",
    minutes: 3,
  },
];

function SourceMark({ item, large = false }: { item: Item; large?: boolean }) {
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-full font-semibold text-white", large ? "size-10 max-md:pointer-coarse:size-12 text-sm" : "size-6 max-md:pointer-coarse:size-8 text-[10px] max-md:pointer-coarse:text-xs")}
      style={{ backgroundColor: item.sourceColor }}
    >
      {item.author.slice(0, 1)}
    </span>
  );
}

function SaveButton({ item, onToggle }: { item: Item; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md p-2 hover:bg-muted"
      onClick={onToggle}
      aria-label="Save item"
    >
      <Icon name="Star" className={cn(COARSE_POINTER_ICON_SIZE_SHRINK_CLASS, item.saved === "saved" && "fill-current")} />
      <span className="text-[11px] max-md:pointer-coarse:hidden">{item.saved === "saved" ? "Saved" : item.saved === "later" ? "Later" : "Save"}</span>
    </button>
  );
}

function ItemFooter({ item, onSave, isRepoLike = false }: { item: Item; onSave: () => void; isRepoLike?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-muted-foreground", isRepoLike ? "border-t border-border" : "border-t border-border/70")}>
      <span className="self-center">{item.tags.slice(0, 2).join(" ")}</span>
      <span className="ml-auto flex items-center gap-1">
        <SaveButton item={item} onToggle={onSave} />
        <button type="button" className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, "hover:bg-muted hover:text-foreground")} aria-label="Open item">
          <Icon name="ArrowUpRight" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} />
        </button>
      </span>
    </div>
  );
}

function ArticleCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <button type="button" className="block p-4 pb-2 text-left" onClick={onOpen}>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <SourceMark item={item} />
          <span className="min-w-0 truncate font-medium text-foreground">{item.source}</span>
          <span>·</span>
          <span className="shrink-0">{item.time}</span>
        </div>
        <h3 className="mt-2.5 text-[15px] max-md:pointer-coarse:text-base font-semibold leading-snug tracking-tight">{item.title}</h3>
        <p className="mt-1.5 line-clamp-2 text-[13px] max-md:pointer-coarse:text-[15px] leading-5 text-muted-foreground">{item.body}</p>
      </button>
      <ItemFooter item={item} onSave={onSave} />
    </article>
  );
}

function VideoCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <button type="button" className={cn("relative block w-full aspect-video max-h-48 bg-gradient-to-br p-5 text-left sm:max-h-56 sm:aspect-auto sm:pb-14", item.thumbAccent)} onClick={onOpen}>
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-11 place-items-center rounded-full bg-background/80 text-background shadow-lg transition-transform group-hover:scale-110">
            <Icon name="Play" className="size-5 translate-x-px fill-current" />
          </span>
        </span>
        <span className="absolute bottom-2 left-3 flex items-center gap-1 font-mono text-[11px] text-foreground/80"><Icon name="Play" className="size-3" /> {item.duration}</span>
        <span className="absolute bottom-2 right-3 text-[11px] text-muted-foreground">{item.views}</span>
      </button>
      <div className="p-4 pb-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <SourceMark item={item} />
          <span className="min-w-0 truncate font-medium text-foreground">{item.source}</span>
          <span>·</span>
          <span className="shrink-0">{item.time}</span>
        </div>
        <h3 className="mt-2.5 text-[15px] font-semibold leading-snug tracking-tight">{item.title}</h3>
      </div>
      <ItemFooter item={item} onSave={onSave} />
    </article>
  );
}

function PostCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <div className="p-4">
        <div className="flex items-start gap-2.5">
          <SourceMark item={item} />
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            <p><span className="font-medium text-foreground">{item.author}</span> <span className="opacity-70">{item.handle}</span></p>
            <p className="mt-0.5">{item.source} · {item.time}</p>
          </div>
          <Icon name="MessageSquare" className="mt-0.5 size-3.5 text-muted-foreground/60" />
        </div>
        <button type="button" className="mt-2.5 block w-full text-left" onClick={onOpen}>
          <p className="text-[13px] leading-6 text-foreground/90">{item.body}</p>
          {item.thread && item.thread.length > 0 && (
            <p className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-primary">{item.thread.length} more in thread <Icon name="ChevronRight" className="size-3" /></p>
          )}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-3 max-md:pointer-coarse:px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 p-1"><Icon name="Star" className="size-3.5 max-md:pointer-coarse:size-5" /> {item.likes}</span>
        <span className="inline-flex items-center gap-1 p-1"><Icon name="Repeat" className="size-3.5 max-md:pointer-coarse:size-5" /> {item.reposts}</span>
        <span className="ml-auto"><SaveButton item={item} onToggle={onSave} /></span>
      </div>
    </article>
  );
}

function RepoCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <div className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon name="GithubLogo" className="size-4 text-foreground/70" />
          <span className="font-mono font-medium text-foreground">{item.fullName}</span>
          <span className="ml-auto">{item.time}</span>
        </div>
        <button type="button" className="mt-2 block w-full text-left" onClick={onOpen}>
          <p className="text-[13px] leading-5 text-muted-foreground">{item.description}</p>
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-3 max-md:pointer-coarse:px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 p-1"><Icon name="Star" className="size-3.5 max-md:pointer-coarse:size-5" /> {item.stars}</span>
        {item.issues && <span className="inline-flex items-center gap-1 p-1"><Icon name="CircleQuestion" className="size-3.5 max-md:pointer-coarse:size-5" /> {item.issues} issues</span>}
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: item.langColor }} />
          {item.language}
        </span>
        <span className="ml-auto"><SaveButton item={item} onToggle={onSave} /></span>
      </div>
    </article>
  );
}

function ReleaseCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <div className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon name="GithubLogo" className="size-4 text-foreground/70" />
          <span className="font-mono font-medium text-foreground">{item.fullName}</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{item.version}</span>
          <span className="ml-auto">{item.time}</span>
        </div>
        <button type="button" className="mt-2.5 w-full space-y-1.5 text-left" onClick={onOpen}>
          {item.changes?.map((change) => (
            <p key={change.hash} className="flex items-baseline gap-2 text-[12px]">
              <span className="font-mono text-[10px] text-muted-foreground/70">{change.hash}</span>
              <span className="text-foreground/85">{change.message}</span>
            </p>
          ))}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-3 max-md:pointer-coarse:px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 p-1"><Icon name="GitBranch" className="size-3.5 max-md:pointer-coarse:size-5" /> main</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 max-md:pointer-coarse:size-3.5 rounded-full" style={{ backgroundColor: item.langColor }} />
          {item.language}
        </span>
        <span className="ml-auto"><SaveButton item={item} onToggle={onSave} /></span>
      </div>
    </article>
  );
}

function PaperCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25">
      <button type="button" className="block p-4 pb-2 text-left" onClick={onOpen}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <SourceMark item={item} />
          <span className="font-medium text-foreground">{item.source}</span>
          <span>·</span>
          <span>{item.time}</span>
        </div>
        <h3 className="mt-2.5 text-[15px] font-medium leading-snug tracking-tight">{item.title}</h3>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{item.body}</p>
      </button>
      <ItemFooter item={item} onSave={onSave} isRepoLike />
    </article>
  );
}

function ItemCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  switch (item.kind) {
    case "video": return <VideoCard item={item} onOpen={onOpen} onSave={onSave} />;
    case "post": return <PostCard item={item} onOpen={onOpen} onSave={onSave} />;
    case "repo": return <RepoCard item={item} onOpen={onOpen} onSave={onSave} />;
    case "release": return <ReleaseCard item={item} onOpen={onOpen} onSave={onSave} />;
    case "paper": return <PaperCard item={item} onOpen={onOpen} onSave={onSave} />;
    default: return <ArticleCard item={item} onOpen={onOpen} onSave={onSave} />;
  }
}

function matchesKind(item: Item, feed: Feed): boolean {
  if (feed === "all") return true;
  if (feed === "saved") return true; // handled by saved filter separately
  if (feed === "articles") return item.kind === "article" || item.kind === "paper";
  if (feed === "videos") return item.kind === "video";
  if (feed === "social") return item.kind === "post";
  return item.kind === "repo" || item.kind === "release";
}

function Reader({ item, onBack, onToggleSaved }: { item: Item; onBack: () => void; onToggleSaved: () => void }) {
  return (
    <main className="h-full min-h-0 overflow-y-auto pb-24 max-md:pointer-coarse:pb-28">
      <div className="mx-auto w-full max-w-2xl px-5 py-6 sm:px-8 sm:py-10">
        <button type="button" onClick={onBack} className="-mt-2 mb-8 inline-flex h-9 items-center gap-2 rounded-full text-sm text-muted-foreground hover:text-foreground sm:mb-10"><Icon name="ChevronLeft" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> Back to feed</button>

        <div className="flex items-center gap-3">
          <SourceMark item={item} large />
          <div>
            <p className="font-medium">{item.source}</p>
            <p className="text-xs text-muted-foreground">{item.day === "today" ? "Today" : "Yesterday"}, {item.time} · {KIND_META[item.kind].label}</p>
          </div>
          <span className="ml-auto rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{item.tags.join(" ")}</span>
        </div>

        {item.kind === "video" ? (
          <>
            <div className={cn("relative mt-6 grid aspect-video max-h-64 w-full place-items-center rounded-2xl bg-gradient-to-br sm:mt-8 sm:max-h-72 sm:aspect-auto", item.thumbAccent)}>
              <span className="grid size-14 place-items-center rounded-full bg-background/85 text-background shadow-xl"><Icon name="Play" className="size-6 translate-x-px fill-current" /></span>
              <span className="absolute bottom-3 right-3 rounded-md bg-background/85 px-2 py-1 font-mono text-xs">{item.duration}</span>
            </div>
            <h1 className="mt-6 text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">{item.title}</h1>
            <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Icon name="Play" className="size-3.5" /> {item.views} · {item.author}</p>
            <p className="mt-6 leading-8 text-foreground/80">{item.body}</p>
            <p className="mt-4 text-sm text-muted-foreground">Watch on {item.source} →</p>
          </>
        ) : item.kind === "post" ? (
          <>
            <h1 className="mt-6 text-xl font-semibold leading-snug tracking-tight sm:text-2xl">{item.author}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{item.handle} · {item.source}</p>
            <p className="mt-6 text-lg leading-8 text-foreground/90">{item.body}</p>
            {item.thread?.map((part, index) => (
              <div key={index} className="mt-6 border-l-2 border-border pl-4">
                <p className="text-base leading-7 text-foreground/75">{part}</p>
              </div>
            ))}
          </>
        ) : item.kind === "repo" || item.kind === "release" ? (
          <>
            <h1 className="mt-8 font-mono text-2xl font-semibold tracking-tight sm:text-3xl">{item.version ?? item.fullName}</h1>
            {item.description && <p className="mt-3 text-muted-foreground">{item.description}</p>}
            {item.changes && (
              <ul className="mt-8 space-y-2 text-sm">
                {item.changes.map((change) => (
                  <li key={change.hash} className="flex items-baseline gap-3"><span className="font-mono text-xs text-muted-foreground/70">{change.hash}</span><span className="text-foreground/85">{change.message}</span></li>
                ))}
              </ul>
            )}
            <p className="mt-8 text-muted-foreground">Open on GitHub →</p>
          </>
        ) : (
          <>
            <h1 className="mt-8 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">{item.title}</h1>
            {item.author && <p className="mt-3 text-sm text-muted-foreground">by {item.author} · {item.minutes} min read</p>}
            <p className="mt-6 text-lg leading-8 text-muted-foreground">{item.body}</p>
            <div className="mt-10 rounded-2xl border border-dashed border-border bg-muted/40 p-8 text-center text-sm text-muted-foreground">Captured article body renders here — sanitized, offline, one file per item.</div>
            <div className="mt-8 space-y-4 text-base leading-7 text-foreground/80">
              <p>Readers stay calm and dense while reading gets a focused canvas that fits the thing being read, not a generic article template.</p>
              <p>A single "turn into thread" action attaches this item and its capture to a workspace thread without leaving the reading flow.</p>
            </div>
          </>
        )}

        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center justify-between text-sm text-muted-foreground">
            <SaveButton item={item} onToggle={onToggleSaved} />
            <Button variant="outline" size="sm" className="h-9 max-md:pointer-coarse:h-10"><Icon name="MessageSquarePlus" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> Turn into thread</Button>
          </div>
        </div>
      </div>
    </main>
  );
}

function StateButton({ state, onCycle }: { state: SavedState; onCycle: () => void }) {
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

const STATE_CYCLE: Record<SavedState, SavedState> = { new: "later", later: "saved", saved: "new", dropped: "new" };

/** Remembered across reader round-trips so triage focus resumes where you acted. */
let lastActedItemId: string | null = null;

function TriageRow({ item, focused, onOpen, onSet, registerRef }: {
  item: Item;
  focused: boolean;
  onOpen: () => void;
  onSet: (state: SavedState) => void;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  const [dx, setDx] = useState(0);
  const touch = useRef<{ x: number; y: number } | null>(null);

  return (
    <div className="relative overflow-hidden rounded-xl">
      <span className="absolute inset-0 grid place-items-center bg-emerald-500/15 text-xs font-medium text-emerald-400 opacity" style={{ opacity: dx > 24 ? Math.min(1, dx / 90) : 0 }}>✓ Save</span>
      <span className="absolute inset-0 grid place-items-center bg-muted text-xs font-medium text-muted-foreground" style={{ opacity: dx < -24 ? Math.min(1, -dx / 90) : 0 }}>✕ Drop</span>
      <div
        ref={registerRef}
        tabIndex={-1}
        onClick={onOpen}
        onFocus={() => undefined}
        onTouchStart={(event) => { touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }; }}
        onTouchMove={(event) => {
          if (!touch.current) return;
          const dx = event.touches[0].clientX - touch.current.x;
          const dy = event.touches[0].clientY - touch.current.y;
          setDx(Math.abs(dx) > Math.abs(dy) ? Math.max(-140, Math.min(140, dx)) : 0);
        }}
        onTouchEnd={() => {
          if (dx > 110) onSet("saved");
          else if (dx < -110) onSet("dropped");
          setDx(0);
        }}
        className={cn(
          "relative flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card px-3 max-md:pointer-coarse:px-4 py-2.5 max-md:pointer-coarse:py-3 transition-[border-color,transform,opacity] border-l-4",
          STATE_ACCENT[item.saved],
          focused && "border-border/0 ring-2 ring-primary/60",
          item.saved === "dropped" && "line-through decoration-muted-foreground/60",
        )}
        style={{ transform: `translateX(${dx}px)` }}
      >
        <StateButton state={item.saved} onCycle={() => onSet(STATE_CYCLE[item.saved])} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-[11px] max-md:pointer-coarse:text-xs text-muted-foreground">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.sourceColor }} />
            <span className="min-w-0 truncate font-medium text-foreground/80">{item.source}</span>
            <span>·</span>
            <span>{item.time}</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline truncate">{KIND_META[item.kind].label}{item.minutes ? ` · ${item.minutes} min` : item.duration ? ` · ${item.duration}` : ""}</span>
            <span className="ml-auto hidden shrink-0 sm:inline">{item.tags.slice(0, 2).join(" ")}</span>
          </div>
          <p className="mt-0.5 truncate text-[13px] max-md:pointer-coarse:text-[15px] font-medium text-foreground/90">
            {item.title ?? item.fullName ?? item.body}
          </p>
          {item.description ? <p className="mt-0.5 line-clamp-1 text-[12px] text-muted-foreground">{item.description}</p> : (item.kind === "post" || item.kind === "article" || item.kind === "paper") && !item.fullName ? <p className="mt-0.5 line-clamp-1 text-[12px] max-md:pointer-coarse:hidden text-muted-foreground">{item.body}</p> : null}
        </div>
      </div>
    </div>
  );
}

function TriageView({ items, onOpen, onSet, activeKindLabel }: { items: Item[]; onOpen: (item: Item) => void; onSet: (id: string, state: SavedState) => void; activeKindLabel: string }) {
  const [focus, setFocus] = useState(() => Math.max(0, items.findIndex((item) => item.id === lastActedItemId)));
  const [toast, setToast] = useState<string | null>(null);
  const undoStack = useRef<Array<{ id: string; state: SavedState; label: string }>>([]);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const lastSet = useRef(onSet);
  lastSet.current = onSet;

  const counts = useMemo(() => {
    const acc: Record<SavedState, number> = { new: 0, later: 0, saved: 0, dropped: 0 };
    for (const item of items) acc[item.saved] += 1;
    return acc;
  }, [items]);

  const apply = (index: number, state: SavedState, advance: boolean) => {
    const item = items[index];
    if (!item) return;
    undoStack.current.push({ id: item.id, state: item.saved, label: item.title ?? item.fullName ?? "item" });
    lastSet.current(item.id, state);
    setToast(`"${item.title ?? item.fullName}" → ${state}`);
    lastActedItemId = item.id;
    if (advance && state !== "later") setFocus((f) => Math.min(f + 1, Math.max(0, items.length - 1)));
  };

  useEffect(() => {
    setFocus((f) => Math.min(f, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    rowRefs.current[focus]?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const move = (delta: number) => {
        event.preventDefault();
        setFocus((f) => Math.max(0, Math.min(items.length - 1, f + delta)));
      };
      if (event.key === "j" || event.key === "ArrowDown") return move(1);
      if (event.key === "k" || event.key === "ArrowUp") return move(-1);
      if (event.key === "o" || event.key === "Enter") {
        const item = items[focus];
        if (item) { event.preventDefault(); onOpen(item); }
        return;
      }
      const item = items[focus];
      if (!item) return;
      if (event.key === "s") apply(focus, "saved", true);
      else if (event.key === "l") apply(focus, "later", true);
      else if (event.key === "x" || event.key === "d") apply(focus, "dropped", true);
      else if (event.key === "r") apply(focus, "new", false);
      else if (event.key === "u" || event.key === "z") {
        const prev = undoStack.current.pop();
        if (prev) { lastSet.current(prev.id, prev.state); setToast(`undid: "${prev.label}"`); }
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, focus]);

  if (items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Inbox zero. {activeKindLabel === "All" ? "Nothing left to triage." : `No ${activeKindLabel.toLowerCase()} items to triage.`}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-1">
        {items.map((item, index) => (
          <TriageRow
            key={item.id}
            item={item}
            focused={index === focus}
            onOpen={() => onOpen(item)}
            onSet={(state) => apply(index, state, true)}
            registerRef={(el) => { rowRefs.current[index] = el; }}
          />
        ))}
      </div>
      <div className="sticky bottom-0 mt-3 border-t border-border bg-background/95 px-1 py-2.5 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-primary" /> {counts.new + counts.later} in queue</span>
          <span className="inline-flex items-center gap-1.5 text-emerald-400">✓ {counts.saved} saved</span>
          <span className="inline-flex items-center gap-1.5 text-amber-400">◔ {counts.later} later</span>
          <span className="hidden sm:inline-flex items-center gap-1">{toast ?? (undoStack.current.length ? "press u to undo" : "j/k move · s save · l later · x drop · o read")}</span>
          {toast && <button type="button" className="underline hover:text-foreground" onClick={() => { const prev = undoStack.current.pop(); if (prev) { lastSet.current(prev.id, prev.state); setToast(`undid: "${prev.label}"`); } }}>undo</button>}
        </div>
      </div>
    </div>
  );
}

const FEED_TABS: Array<[Feed, string]> = [
  ["all", "All"],
  ["articles", "Articles"],
  ["videos", "Videos"],
  ["social", "Social"],
  ["code", "Code"],
  ["saved", "Saved"],
];

function FluxPage({ subPath }: { subPath?: string }) {
  const navigate = useBbNavigate();
  const [feed, setFeed] = useState<Feed>("all");
  const [items, setItems] = useState(ITEMS);

  const [view, setView] = useState<"cards" | "triage">("cards");

  const activeItem = useMemo(() => {
    const route = decodeURIComponent((subPath ?? "").replace(/^\/+|\/+$/g, ""));
    return route ? items.find((item) => item.id === route) ?? null : null;
  }, [subPath, items]);

  const openItem = (item: Item) => navigate.toPluginPanel("feed", { subPath: item.id });
  const closeReader = () => navigate.toPluginPanel("feed", { replace: true });

  const visible = useMemo(() => items.filter((item) => {
    if (!matchesKind(item, feed)) return false;
    if (view === "triage") return true;
    if (feed === "saved") return item.saved === "saved" || item.saved === "later";
    return item.saved !== "dropped";
  }), [feed, view, items]);

  const byDay = useMemo(() => {
    const groups: Array<[string, Item[]]> = [["Today", []], ["Yesterday", []]];
    for (const item of visible) {
      const bucket = item.day === "today" ? groups[0][1] : groups[1][1];
      bucket.push(item);
    }
    return groups.filter(([, items]) => items.length > 0);
  }, [visible]);

  const setState = (id: string, state: SavedState) => setItems((current) => current.map((item) => item.id === id ? { ...item, saved: state } : item));
  const toggleSaved = (id: string) => setItems((current) => current.map((item) => item.id === id ? { ...item, saved: item.saved === "saved" ? "new" : "saved" } : item));

  if (activeItem) return <Reader item={activeItem} onBack={closeReader} onToggleSaved={() => toggleSaved(activeItem.id)} />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b border-border px-3 max-sm:pointer-coarse:px-4 py-3 max-sm:pointer-coarse:py-4 sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Flux</h1>
            <p className="hidden sm:block text-xs text-muted-foreground">A reading room for ideas worth keeping — articles, videos, posts, and repos in one calm queue.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-border p-0.5" role="tablist" aria-label="Feed layout">
              {([
                ["cards", "GridView"],
                ["triage", "ListView"],
              ] as Array<["cards" | "triage", "GridView" | "ListView"]>).map(([mode, icon]) => (
                <button key={mode} type="button" aria-pressed={view === mode} aria-label={mode === "cards" ? "Card view" : "Triage view"} onClick={() => setView(mode)} className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS + " grid place-items-center rounded-md transition-colors", view === mode ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  <Icon name={icon} className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} />
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="h-8 max-md:pointer-coarse:h-10" onClick={() => navigate.toCompose()}><Icon name="GridView" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> <span className="hidden sm:inline">Back to BB</span></Button>
          </div>
        </div>
      </header>
      <div className={cn("min-h-0 flex-1", view === "triage" ? "flex flex-col" : "overflow-y-auto pb-[env(safe-area-inset-bottom)]")}>
        <div className={cn("mx-auto w-full max-w-5xl px-3 max-sm:pointer-coarse:px-4 py-4 sm:px-8 sm:py-6", view === "triage" && "flex min-h-0 flex-1 flex-col")}>
          <nav aria-label="Feed filters" className={cn("-mx-1 flex gap-1 overflow-x-auto px-1 pb-1", view === "triage" ? "mb-4" : "mb-5")}>
            {FEED_TABS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setFeed(id)} className={cn("shrink-0 rounded-full px-3.5 py-1.5 max-md:pointer-coarse:px-4 max-md:pointer-coarse:py-2 text-[13px] max-md:pointer-coarse:text-sm transition-colors", feed === id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>{label}</button>
            ))}
          </nav>
          {view === "triage" ? (
            <TriageView items={visible} onOpen={(item) => openItem(item)} onSet={setState} activeKindLabel={FEED_TABS.find(([id]) => id === feed)?.[1] ?? "All"} />
          ) : (
            <>
          {byDay.length === 0 && <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Nothing here yet.</p>}
          {byDay.map(([label, dayItems]) => (
            <section key={label} className="mb-2">
              <h2 className="sticky top-0 z-10 -mx-2 mb-3 bg-background/90 px-2 py-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground backdrop-blur">{label} · {dayItems.length}</h2>
              <div className="grid items-start gap-3 md:grid-cols-2">
                {dayItems.map((item) => <ItemCard key={item.id} item={item} onOpen={() => openItem(item)} onSave={() => toggleSaved(item.id)} />)}
              </div>
            </section>
          ))}
          <p className="mt-8 text-center text-xs text-muted-foreground">Realistic sample data — the plugin will ingest articles, videos, posts, repos, and releases from multiple sources</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "flux", title: "Flux", icon: "Explore", path: "feed", component: FluxPage });
});

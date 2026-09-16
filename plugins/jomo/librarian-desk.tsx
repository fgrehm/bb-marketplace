import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type DeskItem = {
  id: string;
  source: string;
  title?: string;
  fullName?: string;
  body: string;
  description?: string;
  tags: string[];
  day: "today" | "yesterday";
  time: string;
  saved: "new" | "later" | "saved" | "dropped";
};

type Proposal =
  | { kind: "hoard"; urls: string[] }
  | { kind: "subscribe"; url: string; name: string };

type Message = {
  id: number;
  role: "you" | "librarian";
  body: string;
  results?: DeskItem[];
  proposal?: Proposal;
  decided?: "confirmed" | "dismissed";
};

const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;
const WELCOME_MESSAGE: Message = { id: 1, role: "librarian", body: "Leave links here, ask for a new source, or ask what is resting in the archive. I will stage changes before touching anything." };
let rememberedMessages: Message[] = [WELCOME_MESSAGE];
const STOP_WORDS = new Set(["about", "anything", "archive", "archived", "did", "find", "from", "have", "hoard", "into", "saved", "show", "stuff", "that", "the", "this", "today", "what", "yesterday", "you"]);

function sourceName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.split(".").slice(0, -1).join(".") || host;
  } catch {
    return "new source";
  }
}

function searchArchive(items: DeskItem[], query: string): DeskItem[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}-]{3,}/gu)?.filter((word) => !STOP_WORDS.has(word)) ?? [];
  const archive = items.filter((item) => item.saved === "saved" || item.saved === "later");
  const pool = /today/i.test(query) ? archive.filter((item) => item.day === "today") : /yesterday/i.test(query) ? archive.filter((item) => item.day === "yesterday") : archive;
  if (words.length === 0) return pool.slice(0, 3);
  return pool
    .map((item) => {
      const text = `${item.title ?? ""} ${item.fullName ?? ""} ${item.body} ${item.description ?? ""} ${item.source} ${item.tags.join(" ")}`.toLowerCase();
      return { item, score: words.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ item }) => item);
}

function assistantReply(items: DeskItem[], text: string, id: number): Message {
  const urls = [...new Set((text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;!?]+$/, "")))];
  const wantsSubscription = /subscribe|follow|feed|rss/i.test(text);
  if (urls.length > 0 && wantsSubscription) {
    const url = urls[0];
    return { id, role: "librarian", body: "I can add this as a paused source. Nothing will arrive until you explicitly turn it on.", proposal: { kind: "subscribe", url, name: sourceName(url) } };
  }
  if (urls.length > 0) {
    return { id, role: "librarian", body: `I found ${urls.length === 1 ? "one link" : `${urls.length} links`}. I can place ${urls.length === 1 ? "it" : "them"} directly in the hoard, without making a reading obligation.`, proposal: { kind: "hoard", urls } };
  }
  const results = searchArchive(items, text);
  if (results.length > 0) {
    return { id, role: "librarian", body: `I found ${results.length === 1 ? "one thing" : `${results.length} things`} in the mock archive that seem relevant.`, results };
  }
  return { id, role: "librarian", body: "I could not find that in the mock archive. I did not broaden the search or invent an answer. Try a source, topic, or date." };
}

export function LibrarianDesk({ items, onClose, onOpenItem, onHoardLinks, onSubscribe }: {
  items: DeskItem[];
  onClose: () => void;
  onOpenItem: (id: string) => void;
  onHoardLinks: (urls: string[]) => void;
  onSubscribe: (name: string, url: string) => void;
}) {
  const nextId = useRef(Math.max(...rememberedMessages.map((message) => message.id)) + 1);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>(rememberedMessages);
  const archivedCount = useMemo(() => items.filter((item) => item.saved === "saved" || item.saved === "later").length, [items]);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bottomRef.current?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const userMessage: Message = { id: nextId.current++, role: "you", body: text };
    const reply = assistantReply(items, text, nextId.current++);
    setMessages((current) => {
      rememberedMessages = [...current, userMessage, reply];
      return rememberedMessages;
    });
    setDraft("");
  };

  const decide = (message: Message, decision: "confirmed" | "dismissed") => {
    if (decision === "confirmed" && message.proposal?.kind === "hoard") onHoardLinks(message.proposal.urls);
    if (decision === "confirmed" && message.proposal?.kind === "subscribe") onSubscribe(message.proposal.name, message.proposal.url);
    setMessages((current) => {
      rememberedMessages = current.map((entry) => entry.id === message.id ? { ...entry, decided: decision } : entry);
      return rememberedMessages;
    });
  };

  return (
    <main className="jomo-enter flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border/60 px-4 py-3 sm:px-8">
        <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Leave librarian desk"><Icon name="ChevronLeft" className="size-4" /></button>
        <div><h1 className="font-semibold tracking-tight">Librarian desk</h1><p className="text-xs text-muted-foreground">{archivedCount} mock items resting · changes always ask first</p></div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-2xl space-y-8">
          {messages.map((message) => (
            <article key={message.id} className={cn("jomo-enter", message.role === "you" && "pl-6 sm:pl-14")}>
              <p className={cn("text-[10px] font-semibold uppercase tracking-[0.16em]", message.role === "librarian" ? "text-amber-400" : "text-muted-foreground")}>{message.role === "librarian" ? "Librarian" : "You"}</p>
              <p className="mt-2 text-sm leading-6 text-foreground/85">{message.body}</p>

              {message.results && <div className="mt-4 space-y-2">{message.results.map((item) => <button type="button" key={item.id} onClick={() => onOpenItem(item.id)} className="block w-full rounded-2xl bg-card/50 px-4 py-3 text-left ring-1 ring-border/40 transition-colors hover:bg-card"><span className="text-sm font-medium">{item.title ?? item.fullName ?? item.body}</span><span className="mt-1 block text-xs text-muted-foreground">{item.source} · {item.day} at {item.time} · {item.saved === "saved" ? "in the hoard" : "resting for later"}</span></button>)}</div>}

              {message.proposal && <div className="mt-4 rounded-2xl bg-card/50 p-4 ring-1 ring-border/40">
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Staged, not applied</p>
                {message.proposal.kind === "hoard" ? <ul className="mt-3 space-y-1.5 text-sm">{message.proposal.urls.map((url) => <li key={url} className="truncate font-mono text-xs text-foreground/75">{url}</li>)}</ul> : <div className="mt-3"><p className="text-sm font-medium">{message.proposal.name}</p><p className="truncate font-mono text-xs text-muted-foreground">{message.proposal.url}</p><p className="mt-2 text-xs text-muted-foreground">Starts paused. You decide when it enters the mock round.</p></div>}
                {message.decided ? <p className="mt-4 text-xs text-muted-foreground">{message.decided === "confirmed" ? "Confirmed. A mock receipt was added locally." : "Left untouched."}</p> : <div className="mt-4 flex gap-2"><Button size="sm" onClick={() => decide(message, "confirmed")}>Confirm</Button><Button size="sm" variant="ghost" onClick={() => decide(message, "dismissed")}>Leave it</Button></div>}
              </div>}
            </article>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <footer className="border-t border-border/60 bg-background/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-8">
        <form className="mx-auto flex max-w-2xl items-end gap-2 rounded-2xl bg-card/60 p-2 ring-1 ring-border/50" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} rows={2} placeholder="Drop links, subscribe to a feed, or ask the archive…" className="max-h-32 min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground" />
          <Button type="submit" size="sm" disabled={!draft.trim()} aria-label="Send to librarian"><Icon name="ChevronRight" className="size-4" /></Button>
        </form>
        <p className="mx-auto mt-2 max-w-2xl text-center text-[10px] text-muted-foreground/70">Mock conversation · heuristic replies · no network or real ingestion</p>
      </footer>
    </main>
  );
}

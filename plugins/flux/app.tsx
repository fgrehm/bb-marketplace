import { useMemo, useState } from "react";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Feed = "all" | "saved" | "ai" | "design";

type Story = {
  id: string;
  source: string;
  sourceColor: string;
  title: string;
  excerpt: string;
  tag: string;
  minutes: number;
  published: string;
  saved?: boolean;
  accent: string;
};

const STORIES: Story[] = [
  {
    id: "interfaces-as-places",
    source: "Dense Discovery",
    sourceColor: "#e76f51",
    title: "Interfaces are becoming places, not pages",
    excerpt: "The best product surfaces invite people to linger, browse, and make connections. A feed can be a workspace without looking like a dashboard.",
    tag: "Design",
    minutes: 6,
    published: "12 min ago",
    saved: true,
    accent: "from-orange-500/20 to-amber-500/5",
  },
  {
    id: "local-first",
    source: "The Pragmatic Engineer",
    sourceColor: "#4f46e5",
    title: "The quiet return of local-first software",
    excerpt: "Offline-capable tools are finding a new audience among teams who want their work to feel fast, private, and resilient by default.",
    tag: "Technology",
    minutes: 9,
    published: "38 min ago",
    accent: "from-indigo-500/20 to-blue-500/5",
  },
  {
    id: "agent-workspaces",
    source: "Lenny's Newsletter",
    sourceColor: "#0f766e",
    title: "What happens when your workspace gets an agent",
    excerpt: "A field guide to products that put context, conversation, and action in the same room.",
    tag: "AI",
    minutes: 8,
    published: "1 hr ago",
    saved: true,
    accent: "from-emerald-500/20 to-teal-500/5",
  },
  {
    id: "small-web",
    source: "Sidebar",
    sourceColor: "#be185d",
    title: "The small web is a big idea",
    excerpt: "Personal publishing is having a moment again. What can a calmer, more intentional internet teach product builders?",
    tag: "Culture",
    minutes: 4,
    published: "Yesterday",
    accent: "from-pink-500/20 to-rose-500/5",
  },
];

function SourceMark({ story, large = false }: { story: Story; large?: boolean }) {
  return (
    <span className={cn("grid shrink-0 place-items-center rounded-full font-semibold text-white", large ? "size-10 text-sm" : "size-6 text-[10px]")} style={{ backgroundColor: story.sourceColor }}>
      {story.source.slice(0, 1)}
    </span>
  );
}

function StoryCard({ story, onOpen, onSave }: { story: Story; onOpen: () => void; onSave: () => void }) {
  return (
    <article className="group overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-foreground/25">
      <button type="button" className={cn("block w-full bg-gradient-to-br p-5 text-left", story.accent)} onClick={onOpen}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><SourceMark story={story} /> <span className="font-medium text-foreground">{story.source}</span><span>·</span><span>{story.published}</span></div>
        <h2 className="mt-8 max-w-xl text-xl font-semibold leading-tight tracking-tight sm:text-2xl">{story.title}</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{story.excerpt}</p>
      </button>
      <div className="flex items-center justify-between border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
        <span>{story.tag} · {story.minutes} min read</span>
        <div className="flex items-center gap-1">
          <button type="button" className="rounded-md p-1.5 hover:bg-muted hover:text-foreground" onClick={onSave} aria-label={story.saved ? "Remove from saved" : "Save story"}>
            <Icon name="Star" className="size-4" />
          </button>
          <button type="button" className="rounded-md p-1.5 hover:bg-muted hover:text-foreground" onClick={onOpen} aria-label={`Open ${story.title}`}><Icon name="ArrowUpRight" className="size-4" /></button>
        </div>
      </div>
    </article>
  );
}

function Reader({ story, onBack }: { story: Story; onBack: () => void }) {
  return (
    <main className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-5 py-6 sm:px-8 sm:py-10">
        <button type="button" onClick={onBack} className="mb-10 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><Icon name="ChevronLeft" className="size-4" /> Back to feed</button>
        <div className="flex items-center gap-3"><SourceMark story={story} large /><div><p className="font-medium">{story.source}</p><p className="text-xs text-muted-foreground">{story.published} · {story.minutes} min read</p></div></div>
        <h1 className="mt-8 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">{story.title}</h1>
        <p className="mt-6 text-lg leading-8 text-muted-foreground">{story.excerpt}</p>
        <div className="my-10 h-48 rounded-2xl bg-gradient-to-br from-primary/20 via-muted to-accent sm:h-64" />
        <div className="space-y-5 text-base leading-8 text-foreground/80"><p>This is a deliberately lightweight reader state for the Flux proof of concept. The real version could fetch and sanitize an article, keep reading position, and attach the page to a BB thread.</p><p>The important interaction is the transition: discovery stays calm and dense, while reading gets a focused canvas. A future action could turn this story into a thread without forcing the user back through the default workspace first.</p></div>
      </div>
    </main>
  );
}

function FluxPage() {
  const navigate = useBbNavigate();
  const [feed, setFeed] = useState<Feed>("all");
  const [stories, setStories] = useState(STORIES);
  const [activeStory, setActiveStory] = useState<Story | null>(null);
  const visibleStories = useMemo(() => stories.filter((story) => feed === "all" || (feed === "saved" && story.saved) || (feed === "ai" && story.tag === "AI") || (feed === "design" && story.tag === "Design")), [feed, stories]);

  if (activeStory) return <Reader story={activeStory} onBack={() => setActiveStory(null)} />;
  const toggleSaved = (id: string) => setStories((current) => current.map((story) => story.id === id ? { ...story, saved: !story.saved } : story));

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b border-border px-5 py-5 sm:px-8">
        <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
          <div><p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">A calmer internet</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Flux</h1><p className="mt-1 text-sm text-muted-foreground">Your reading room for ideas worth keeping.</p></div>
          <div className="flex items-center gap-2"><Button variant="outline" size="sm" onClick={() => navigate.toCompose()}><Icon name="GridView" className="size-4" /> <span className="hidden sm:inline">Back to BB</span></Button><Button size="icon" variant="ghost" aria-label="Refresh feed" onClick={() => setStories([...STORIES])}><Icon name="RotateCcw" className="size-4" /></Button></div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
        <nav aria-label="Feed filters" className="mb-6 flex gap-1 overflow-x-auto pb-1">{([ ["all", "For you"], ["saved", "Saved"], ["ai", "AI & tools"], ["design", "Design"] ] as Array<[Feed, string]>).map(([id, label]) => <button key={id} type="button" onClick={() => setFeed(id)} className={cn("shrink-0 rounded-full px-4 py-2 text-sm transition-colors", feed === id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>{label}{id === "saved" && <span className="ml-1.5 opacity-60">2</span>}</button>)}</nav>
        <div className="mb-5 flex items-center justify-between"><p className="text-sm text-muted-foreground">{feed === "all" ? "Today, curated for you" : feed === "saved" ? "Your saved stories" : feed === "ai" ? "AI & tools" : "Design notes"}</p><span className="text-xs text-muted-foreground">{visibleStories.length} stories</span></div>
        <section className="grid gap-4 md:grid-cols-2">{visibleStories.map((story) => <StoryCard key={story.id} story={story} onOpen={() => setActiveStory(story)} onSave={() => toggleSaved(story.id)} />)}</section>
        {visibleStories.length === 0 && <p className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Nothing here yet.</p>}
        <p className="mt-8 text-center text-xs text-muted-foreground">Fake data for the Flux UX proof of concept</p>
      </div></div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "flux", title: "Flux", icon: "Explore", path: "feed", component: FluxPage });
});

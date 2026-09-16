import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { LibrarianDesk } from "./librarian-desk";
import { NotebookPanel, Onboarding, type LibrarianProfile } from "./onboarding";
import type { rpcContract } from "./server";
import "./jomo.css";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
} from "@/components/ui/coarse-pointer-sizing";

type ItemKind = "article" | "video" | "post" | "repo" | "release" | "paper";

type Feed = "all" | "articles" | "videos" | "social" | "code" | "saved";

type SavedState = "new" | "later" | "saved" | "dropped";

type Item = {
  id: string;
  kind: ItemKind;
  source: string;
  sourceId?: string;
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

// ---------------------------------------------------------------------------
// BBM-3 volume batch: a realistic ~300-item round so the funnel/backlog UX
// gets tested at true scale before any virtualization is considered.
// Deterministic PRNG keeps the batch stable across reloads.

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type VolumeSpec = {
  id: string;
  source: string;
  sourceColor: string;
  author: string;
  kind: ItemKind;
  tags: string[];
  minutes?: [number, number];
  volume: [number, number]; // [today, yesterday]
  titles: string[];
  bodies: string[];
};

const VIDEO_ACCENTS = [
  "from-teal-500/30 via-sky-600/10 to-transparent",
  "from-slate-500/30 via-slate-700/10 to-transparent",
  "from-emerald-600/30 via-teal-700/10 to-transparent",
  "from-orange-500/25 via-red-700/10 to-transparent",
  "from-indigo-500/30 via-violet-700/10 to-transparent",
];

const RELEASE_MESSAGES = [
  "slots: register nav panels with stable ordering keys",
  "app: expose toCompose() navigation from panel slots",
  "types: shim vaul + portal radix families for app bundles",
  "fix: release host RPC tokens on plugin disable",
  "server: stream JSONL progress for long-running commands",
  "ui: virtualized lists for panels with 500+ rows",
  "docs: document the subPath routing contract",
  "perf: batch IPC writes behind a 16ms frame flush",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

const VOLUME_SOURCE_ID_OVERRIDES: Record<string, string> = {
  renata: "social-informal",
  liw: "social-liw",
  "gh-releases": "lex",
};

function buildVolumeBatch(): Item[] {
  const rand = mulberry32(20260916);
  const pick = <T,>(bank: T[]): T => bank[Math.floor(rand() * bank.length)];
  const items: Item[] = [];
  const specs: VolumeSpec[] = [
    {
      id: "hackaday", source: "Hackaday", sourceColor: "#84cc16", author: "Hackaday", kind: "article", minutes: [4, 9],
      volume: [18, 58], tags: ["#repair", "#CRT", "#hardware", "#retro", "#FPGA"],
      titles: [
        "The Tube Computer, Part {part}: Address Decoding With Relays",
        "Retrotechtacular: When {brand} Ruled the Living Room",
        "This {adj} CNC Is Built Entirely From Printer Parts",
        "Ask Hackaday: How Do You Store {years} Years Of Notes?",
        "A Homebrew CPU With An {adj} Instruction Set",
        "Repairing The {adj} Power Supply That Refuses To Die",
        "{adj} Teardown: Inside A {year} Handheld Console",
        "Building A Weather Station That Outlives Its Maker",
        "The Fork-Bomb That Nearly Took Down {year}'s Hackerspace",
        "E-Paper Dashboard Rides An ESP32 And A Solar Panel",
        "Vintage Calculator Gets A {adj} Second Life",
        "When Your Oscilloscope Is Older Than You Are",
      ],
      bodies: [
        "Build log with photos, the usual teardown forensics, and one genuinely clever trick worth stealing.",
        "The author documents every failure on the way to a working prototype — including the one that released the smoke.",
        "Part restoration, part archaeology: what survives, what re-caps, and what has to be reverse-engineered from scratch.",
        "Fifteen minutes of reading that quietly teaches you more than a semester of datasheets.",
      ],
    },
    {
      id: "kottke", source: "kottke.org", sourceColor: "#18a999", author: "Jason Kottke", kind: "article", minutes: [2, 6],
      volume: [12, 44], tags: ["#culture", "#coffee", "#design", "#media"],
      titles: [
        "The {adj} Economics Of Specialty Coffee",
        "A Short Film About People Who Restore {adj} Things",
        "Notes On The Death Of The Personal Website",
        "The Best Map Of {year} You'll See This Week",
        "Why Every City Thinks Its Bus System Is The Worst",
        "The Quiet Return Of The Home Page",
        "RIP {Thing}: A Eulogy For {adj} Internet Culture",
        "What The Archive Forgets: {Thing} Edition",
        "A {year} Film That Predicts The Feed",
        "The {adj} Appeal Of Owning Nothing Digital",
        "On Reading 300 Links And Remembering None",
        "Coffee, But Make It A Group Chat",
      ],
      bodies: [
        "A short, sharp cultural observation with a long tail of good links at the end.",
        "Kottke links his way through the week; the destination matters less than the wander.",
        "The kind of post you finish in ninety seconds and think about for three days.",
      ],
    },
    {
      id: "techcrunch", source: "TechCrunch", sourceColor: "#e11d48", author: "TechCrunch", kind: "article", minutes: [3, 7],
      volume: [9, 49], tags: ["#startups", "#funding", "#AI", "#space"],
      titles: [
        "{Startup} Raises ${amount}M To {pitch}",
        "Inside The {adj} Race To Automate {Thing}",
        "Sources: {Startup} In Talks At A ${amount}B Valuation",
        "The {Thing} Bubble Is Deflating, Say {adj} Investors",
        "{Startup} Shuts Down {n} Months After Launch",
        "Regulators Widen Probe Into {Thing} Practices",
        "Why Every {Thing} Startup Suddenly Needs An Agent",
      ],
      bodies: [
        "Deal coverage with the usual unnamed sources and a chart that could say anything.",
        "Reporter-style recap of a funding round, a founder quote, and a market-size claim worth discounting.",
      ],
    },
    {
      id: "atarde", source: "A TARDE", sourceColor: "#f97316", author: "A TARDE", kind: "article", minutes: [2, 4],
      volume: [8, 27], tags: ["#Salvador", "#Bahia", "#local"],
      titles: [
        "Prefeitura de Salvador anuncia {obra} no {bairro}",
        "Carnaval {year}: {bairro} recebe {n} blocos confirmados",
        "Porto de Salvador bate recorde de movimentação no trimestre",
        "Novo terminal do Aeroporto de Salvador entra em operação",
        "Festival em {bairro} reúne {n} mil pessoas no fim de semana",
        "Obras da orla entram em nova fase e mudam trânsito no {bairro}",
        "Programação cultural de setembro em Salvador tem {n} eventos gratuitos",
      ],
      bodies: [
        "Resumo da reportagem local: a prefeitura confirma prazos e a reportagem ouve moradores sobre o impacto.",
        "A TARDE cobre o dia a dia de Salvador — transporte, cultura e os anúncios que mudam a rotina da cidade.",
      ],
    },
    {
      id: "sprudge", source: "Sprudge", sourceColor: "#78716c", author: "Sprudge", kind: "article", minutes: [3, 6],
      volume: [6, 21], tags: ["#coffee", "#culture"],
      titles: [
        "The {adj} Rise Of {city}'s Third-Wave Scene",
        "A Cupping Notes Diary: {Thing} From {city}",
        "Meet The Roaster Keeping {Thing} Alive In {city}",
        "Is {adj} Coffee A Scam? We Asked {n} Baristas",
        "The Espresso Machine That Refuses To Die",
      ],
      bodies: [
        "Coffee journalism with strong opinions about grinders and stronger opinions about people.",
        "A profile piece that treats cafés like the small theaters they are.",
      ],
    },
    {
      id: "arxiv", source: "arXiv", sourceColor: "#b91c1c", author: "anon. et al.", kind: "paper", minutes: [22, 40],
      volume: [4, 16], tags: ["#HCI", "#agents", "#retrieval", "#systems"],
      titles: [
        "Measuring Trust Calibration In Mixed Human-Agent Triage",
        "Corpus Effects In {adj} Retrieval For Personal Archives",
        "A Taxonomy Of {adj} Interruptions In Assistants",
        "Self-Forgetting Systems: {Thing} As A First-Class Operation",
        "Benchmarking {n} Personal Knowledge Assistants On Recall",
      ],
      bodies: [
        "Abstract promises a benchmark; the interesting part is always section 5. Skim-worthy, cite-worthy, rarely read fully.",
        "Evaluation across {n} participants with pre-registered analysis; effect sizes modest, honestly reported.",
      ],
    },
    {
      id: "renata", source: "informal.social", sourceColor: "#7c3aed", author: "Renata Campos", kind: "post",
      volume: [7, 13], tags: ["#agents", "#process", "#tooling"],
      titles: [], bodies: [
        "Hot take: your agent's backlog is the backlog. Triage should happen where the work lives, not in a private file.",
        "Every demo of an agent product skips the boring part: what happens to the 200 things it decided for you while you slept.",
        "Unpopular opinion: the best agent UI is a feed. Logs are for machines, feeds are for people.",
        "Spent the morning watching people use an agent sidebar. Nobody found the undo. Nobody.",
        "Reminder that 'the model' is never the bottleneck. The queue is the bottleneck. The queue is always the bottleneck.",
      ],
    },
    {
      id: "liw", source: "fosstodon.org", sourceColor: "#059669", author: "Lars Wirzenius", kind: "post",
      volume: [5, 18], tags: ["#linux", "#web", "#tools"],
      titles: [], bodies: [
        "Annoyed by {thing} again. Wrote a 200-line script instead of filing a bug, like a reasonable person.",
        "FLOSS is not about the license. It's about being able to leave, and knowing it.",
        "Reminder that backups are a moral obligation to your future self.",
        "Every few years I re-learn that email is the only protocol that survived everything.",
        "Migrated another service off the big cloud. The bill went down and so did the anxiety.",
      ],
    },
    {
      id: "yt-lowlevel", source: "YouTube", sourceColor: "#dc2626", author: "Low Level Learning", kind: "video",
      volume: [3, 12], tags: ["#systems", "#C", "#embedded"],
      titles: [
        "Why Your {Thing} Is Slower Than You Think (And How To Fix It)",
        "Reading {years}-Year-Old Firmware So You Don't Have To",
        "The {adj} Truth About Undefined Behavior",
        "Debugging A Heisenbug With Only {n} LEDs And A Logic Analyzer",
      ],
      bodies: [
        "Visual walkthrough with a scope on screen the whole time; the last third is where the payoff lives.",
      ],
    },
    {
      id: "yt-bitluni", source: "YouTube", sourceColor: "#ef4444", author: "Bitluni", kind: "video",
      volume: [2, 6], tags: ["#ESP32", "#hardware", "#linux"],
      titles: [
        "Booted Linux On A {price} Microcontroller — Full Walkthrough",
        "I Built A {adj} Display From Scratch (Part {part})",
        "Reverse-Engineering A {year} Game Console's Video Output",
      ],
      bodies: [
        "Hands-on hardware hackery with schematics in the description and a soldering iron that never rests.",
      ],
    },
    {
      id: "exe-dev", source: "exe.dev", sourceColor: "#0ea5e9", author: "exe.dev", kind: "article", minutes: [6, 14],
      volume: [2, 3], tags: ["#AI", "#agents"],
      titles: [
        "Transient State For Agents: What Survives The Session",
        "The Case For Boring Interfaces Around Smart Systems",
        "Your Assistant Needs A Library, Not A Memory",
        "Rendering Outcomes: Why Agents Should Not Own State",
      ],
      bodies: [
        "Essay-style, one idea per paragraph, no filler — exe.dev rarely wastes a screen.",
      ],
    },
    {
      id: "pragmatic", source: "The Pragmatic Engineer", sourceColor: "#f59e0b", author: "Gergely Orosz", kind: "article", minutes: [7, 12],
      volume: [1, 2], tags: ["#AI", "#product", "#teams"],
      titles: [
        "What Happens When Your Workspace Gets An Agent",
        "Inside {n} Teams That Ship With Agent Pairing",
        "The {adj} Economics Of AI-Assisted Code Review",
      ],
      bodies: [
        "Field reporting with real org names and the numbers behind the anecdotes.",
      ],
    },
    {
      id: "gh-releases", source: "GitHub", sourceColor: "#3f3f46", author: "GitHub", kind: "release",
      volume: [3, 9], tags: ["#SDK", "#plugins", "#tools"],
      titles: [], bodies: [],
    },
  ];

  const words: Record<string, string[]> = {
    adj: ["Humble", "Stubborn", "Forgotten", "Improbable", "Elegant", "Unhinged", "Patient", "Chaotic"],
    thing: ["RSS", "the inbox", "the archive", "scraping", "the bookmark", "IRC", "the wiki"],
    n: ["3", "5", "7", "12", "42", "300"],
    part: ["2", "3", "4", "5", "7", "12"],
    years: ["3", "5", "7", "12", "20", "42"],
    brand: ["Sony", "JVC", "RCA", "Philips", "Sanyo"],
    pitch: ["automate the inbox", "replace spreadsheets", "index personal archives", "agentify on-call"],
    Thing: ["RSS", "The Inbox", "The Archive", "Scraping", "The Bookmark", "IRC", "The Wiki"],
    city: ["Salvador", "São Paulo", "Lisbon", "Berlin", "Melbourne", "Osaka"],
    bairro: ["Rio Vermelho", "Pituba", "Barra", "Itapuã", "Pelourinho", "Cabula"],
    obra: ["novo corredor de ônibus", "praça revitalizada", "ciclovia da orla", "centro de convenções", "terminal urbano"],
    year: ["1979", "1986", "1994", "2003", "2011"],
    price: ["$4", "$8", "$12"],
    Startup: ["Parrot", "Loomwork", "Driftline", "Kernel & Co", "Brightqueue", "Fogbound"],
    amount: ["12", "24", "40", "85", "140"],
  };
  const fill = (template: string): string =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => {
      const bank = words[key] ?? words["thing"];
      return bank[Math.floor(rand() * bank.length)];
    });

  for (const spec of specs) {
    for (const [dayIdx, count] of [spec.volume[0], spec.volume[1]].entries()) {
      const day = dayIdx === 0 ? "today" : "yesterday";
      const startHour = dayIdx === 0 ? 7 : 6;
      const span = dayIdx === 0 ? 11 : 17;
      for (let i = 0; i < count; i++) {
        const title = spec.titles.length ? fill(pick(spec.titles)) : undefined;
        const body = spec.kind === "post" ? pick(spec.bodies) : spec.kind === "release" ? "" : fill(pick(spec.bodies));
        const hour = startHour + Math.floor(rand() * span);
        const time = `${pad2(Math.min(hour, 22))}:${pad2(Math.floor(rand() * 60))}`;
        const saved: SavedState = dayIdx === 0
          ? rand() < 0.03 ? "dropped" : rand() < 0.08 ? "saved" : rand() < 0.1 ? "later" : "new"
          : rand() < 0.5 ? "dropped" : rand() < 0.18 ? "saved" : rand() < 0.38 ? "later" : "new";
        const tags = [spec.tags[Math.floor(rand() * spec.tags.length)]]; // one tag is enough at this volume
        if (rand() < 0.5) {
          const extra = spec.tags[Math.floor(rand() * spec.tags.length)];
          if (!tags.includes(extra)) tags.push(extra);
        }
        const base: Item = {
          id: `${spec.id}-${dayIdx}-${i}`,
          kind: spec.kind,
          source: spec.source,
          sourceId: VOLUME_SOURCE_ID_OVERRIDES[spec.id] ?? spec.id,
          sourceColor: spec.sourceColor,
          author: spec.author,
          title,
          body,
          time,
          day,
          tags,
          saved,
        };
        if (spec.kind === "article" || spec.kind === "paper") {
          const [lo, hi] = spec.minutes ?? [3, 8];
          base.minutes = lo + Math.floor(rand() * (hi - lo));
        } else if (spec.kind === "video") {
          base.duration = `${pad2(8 + Math.floor(rand() * 42))}:${pad2(Math.floor(rand() * 60))}`;
          base.views = `${(rand() * 900 + 20).toFixed(0)}K views`;
          base.thumbAccent = VIDEO_ACCENTS[Math.floor(rand() * VIDEO_ACCENTS.length)];
        } else if (spec.kind === "post") {
          base.handle = `@${spec.id}@${spec.source}`;
          base.likes = `${(rand() * 4 + 0.2).toFixed(1)}K`;
          base.reposts = `${Math.floor(rand() * 400 + 12)}`;
        } else if (spec.kind === "release") {
          base.fullName = pick(["get-bb/plugin-sdk", "facebook/lexical", "zod/zod", "honojs/hono"]);
          base.stars = `${(rand() * 20 + 0.4).toFixed(1)}k`;
          base.language = "TypeScript";
          base.langColor = "#3178c6";
          base.issues = `${Math.floor(rand() * 700)}`;
          base.version = `v0.${4 + Math.floor(rand() * 3)}.${Math.floor(rand() * 120)}`;
          base.changes = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => ({
            hash: Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0"),
            message: pick(RELEASE_MESSAGES),
          }));
        }
        items.push(base);
      }
    }
  }
  return items;
}

const CURATED_ITEMS: Item[] = [
  {
    id: "mayfly-chat",
    kind: "article",
    source: "exe.dev",
    sourceId: "exe-dev",
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
    sourceId: "yt-fetalsai",
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
    sourceId: "social-informal",
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
    sourceId: "lex",
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
    sourceId: "pragmatic",
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
    sourceId: "lex",
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
    sourceId: "arxiv",
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
    sourceId: "hackaday",
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
    sourceId: "yt-bitluni",
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
    sourceId: "social-liw",
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
    id: "repo-jomo",
    kind: "repo",
    source: "GitHub",
    sourceId: "lex",
    sourceColor: "#3f3f46",
    author: "fgrehm/bb-marketplace",
    body: "",
    time: "09:12",
    day: "yesterday",
    tags: ["#plugins", "#BB"],
    saved: "saved",
    fullName: "fgrehm/bb-marketplace",
    description: "Independently installable BB plugins: jomo, Review Workspace, favicon, and friends.",
    stars: "143",
    language: "TypeScript",
    langColor: "#3178c6",
    issues: "3",
  },
  {
    id: "kottke-spice",
    kind: "article",
    source: "kottke.org",
    sourceId: "kottke",
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

const ITEMS: Item[] = [...CURATED_ITEMS, ...buildVolumeBatch()].sort((a, b) => {
  if (a.day !== b.day) return a.day === "today" ? -1 : 1;
  return a.time < b.time ? 1 : a.time > b.time ? -1 : 0; // newest first
});

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
      aria-label="Ingest item"
    >
      <Icon name="Star" className={cn(COARSE_POINTER_ICON_SIZE_SHRINK_CLASS, item.saved === "saved" && "fill-current")} />
      <span className="text-[11px] max-md:pointer-coarse:hidden">{item.saved === "saved" ? "Ingested" : item.saved === "later" ? "Later" : "Ingest"}</span>
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
        <span className="inline-flex items-center p-1">{item.likes} likes</span>
        <span className="inline-flex items-center p-1">{item.reposts} reposts</span>
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
        <span className="inline-flex items-center p-1">{item.stars} stars</span>
        {item.issues && <span className="inline-flex items-center p-1">{item.issues} open issues</span>}
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
        <span className="inline-flex items-center p-1">{item.stars} stars</span>
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
let adHocSequence = 0;

function TriageRow({ item, focused, onOpen, onSet, registerRef }: {
  item: Item;
  focused: boolean;
  onOpen: () => void;
  onSet: (state: SavedState) => void;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  const [dx, setDx] = useState(0);
  const divRef = useRef<HTMLDivElement | null>(null);

  // Gesture isolation: native, non-passive listeners so preventDefault is
  // honored, stopPropagation keeps the touch away from document-level
  // listeners (the app's left-nav drawer), and pointer capture takes the
  // gesture away from pointer-based handlers. Edge zone (32px) stays with
  // the app nav on purpose.
  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let edge = false;
    let offset = 0;
    let claimed = false;
    let pointerId: number | null = null;

    const releasePointer = () => {
      if (pointerId !== null) {
        try { el.releasePointerCapture(pointerId); } catch { /* noop */ }
        pointerId = null;
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY };
      edge = touch.clientX < 32 || touch.clientX > window.innerWidth - 32;
      claimed = false;
      if (!edge) event.stopPropagation();
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!start) return;
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      offset = Math.abs(dx) > Math.abs(dy) ? Math.max(-140, Math.min(140, dx)) : 0;
      if (edge) return;
      if (!claimed && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) claimed = true;
      if (claimed) { event.preventDefault(); event.stopPropagation(); }
      setDx(offset);
    };

    const onTouchEnd = () => {
      if (!edge) {
        if (offset > 110) onSet("saved");
        else if (offset < -110) onSet("dropped");
      }
      offset = 0; start = null; edge = false; claimed = false;
      releasePointer();
      setDx(0);
    };

    const onPointerDown = (event: PointerEvent) => {
      edge = event.clientX < 32 || event.clientX > window.innerWidth - 32;
      if (edge) return;
      pointerId = event.pointerId;
      try { el.setPointerCapture(event.pointerId); } catch { /* already captured */ }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("pointerdown", onPointerDown);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onSet, onOpen]);

  return (
    <div className="relative overflow-hidden rounded-xl">
      <span className="absolute inset-0 grid place-items-center bg-emerald-500/15 text-xs font-medium text-emerald-400" style={{ opacity: dx > 24 ? Math.min(1, dx / 90) : 0 }}>✓ Ingest</span>
      <span className="absolute inset-0 grid place-items-center bg-muted text-xs font-medium text-muted-foreground" style={{ opacity: dx < -24 ? Math.min(1, -dx / 90) : 0 }}>✕ Drop</span>
      <div
        ref={(el) => { divRef.current = el; registerRef(el); }}
        tabIndex={-1}
        onClick={onOpen}
        onFocus={() => undefined}
        style={{ touchAction: "pan-y", transform: `translateX(${dx}px)` }}
        className={cn(
          "relative flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card px-3 max-md:pointer-coarse:px-4 py-2.5 max-md:pointer-coarse:py-3 transition-[border-color,transform,opacity] border-l-4",
          STATE_ACCENT[item.saved],
          focused && "border-border/0 ring-2 ring-primary/60",
          item.saved === "dropped" && "line-through decoration-muted-foreground/60",
        )}
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
      <div className="min-h-0 max-h-full flex-1 space-y-1 overflow-y-auto">
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
          <span className="inline-flex items-center gap-1.5 text-emerald-400">✓ {counts.saved} ingested</span>
          <span className="inline-flex items-center gap-1.5 text-amber-400">◔ {counts.later} later</span>
          <span className="hidden sm:inline-flex items-center gap-1">{toast ?? (undoStack.current.length ? "press u to undo" : "j/k move · s ingest · l later · x drop · o read")}</span>
          {toast && <button type="button" className="underline hover:text-foreground" onClick={() => { const prev = undoStack.current.pop(); if (prev) { lastSet.current(prev.id, prev.state); setToast(`undid: "${prev.label}"`); } }}>undo</button>}
        </div>
      </div>
    </div>
  );
}

type RssSourceKind = "rss" | "mastodon" | "github" | "youtube";

type Source = {
  id: string;
  name: string;
  url: string;
  kind: RssSourceKind;
  color: string;
  enabled: boolean;
  lastFetch: string;
};

const SOURCE_KIND_META: Record<RssSourceKind, { label: string; icon: React.ComponentProps<typeof Icon>["name"] }> = {
  rss: { label: "RSS feed", icon: "Globe" },
  mastodon: { label: "Account", icon: "MessageSquare" },
  github: { label: "GitHub", icon: "GithubLogo" },
  youtube: { label: "YouTube", icon: "Play" },
};

const SOURCES: Source[] = [
  { id: "hackaday", name: "Hackaday", url: "https://hackaday.com/feed", kind: "rss", color: "#84cc16", enabled: true, lastFetch: "9 min ago" },
  { id: "techcrunch", name: "TechCrunch", url: "https://techcrunch.com/feed", kind: "rss", color: "#e11d48", enabled: true, lastFetch: "12 min ago" },
  { id: "kottke", name: "kottke.org", url: "https://feeds.kottke.org/main", kind: "rss", color: "#18a999", enabled: true, lastFetch: "26 min ago" },
  { id: "atarde", name: "A TARDE", url: "https://atarde.com.br/rss", kind: "rss", color: "#f97316", enabled: true, lastFetch: "18 min ago" },
  { id: "sprudge", name: "Sprudge", url: "https://sprudge.com/feed", kind: "rss", color: "#78716c", enabled: true, lastFetch: "40 min ago" },
  { id: "arxiv", name: "arXiv (cs.HC)", url: "https://arxiv.org/rss/cs.HC", kind: "rss", color: "#b91c1c", enabled: true, lastFetch: "1 hr ago" },
  { id: "exe-dev", name: "exe.dev", url: "https://blog.exe.dev/feed", kind: "rss", color: "#0ea5e9", enabled: true, lastFetch: "12 min ago" },
  { id: "pragmatic", name: "The Pragmatic Engineer", url: "https://newsletter.pragmaticengineer.com/feed", kind: "rss", color: "#f59e0b", enabled: true, lastFetch: "26 min ago" },
  { id: "lex", name: "GitHub releases", url: "https://github.com/ facebook/lexical", kind: "github", color: "#3f3f46", enabled: true, lastFetch: "2 hr ago" },
  { id: "social-informal", name: "@renata@informal.social", url: "https://informal.social/users/renata.rss", kind: "mastodon", color: "#7c3aed", enabled: true, lastFetch: "34 min ago" },
  { id: "social-liw", name: "@liw@fosstodon.org", url: "https://fosstodon.org/users/liw.rss", kind: "mastodon", color: "#059669", enabled: true, lastFetch: "1 hr ago" },
  { id: "yt-bitluni", name: "Bitluni / YouTube", url: "https://www.youtube.com/c/Bitluni/videos", kind: "youtube", color: "#dc2626", enabled: true, lastFetch: "5 hr ago" },
  { id: "yt-lowlevel", name: "Low Level Learning / YouTube", url: "https://www.youtube.com/c/LowLevel/videos", kind: "youtube", color: "#ef4444", enabled: true, lastFetch: "3 hr ago" },
  { id: "yt-fetalsai", name: "fetalsai / YouTube", url: "https://www.youtube.com/@festivetech", kind: "youtube", color: "#0f766e", enabled: true, lastFetch: "6 hr ago" },
  { id: "sumau", name: "SUMAUMA", url: "https://sumauma.com/feed", kind: "rss", color: "#15803d", enabled: false, lastFetch: "paused 2 days ago" },
];

function colorFromString(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) & 0xffffff;
  const hue = hash % 360;
  return `hsl(${hue} 62% 52%)`;
}

function sourceNameForHost(host: string): string {
  const known: Array<[string, string]> = [
    ["github", "GitHub"],
    ["youtube", "YouTube"],
    ["x", "x.com"],
    ["twitter", "Twitter"],
    ["arxiv", "arXiv"],
    ["mastodon", "Mastodon"],
    ["fosstodon", "fosstodon.org"],
    ["informal", "informal.social"],
  ];
  for (const [needle, name] of known) if (host.includes(needle)) return name;
  return host;
}

function inferKindFromUrl(rawUrl: string): { kind: ItemKind; label: string } {
  let host = "";
  try { host = new URL(rawUrl).hostname; } catch { return { kind: "article", label: "link" }; }
  if (host.includes("github.com")) return { kind: "repo", label: "repo" };
  if (host.includes("youtube.com") || host === "youtu.be") return { kind: "video", label: "video" };
  if (host.includes("x.com") || host.includes("twitter.com") || host.includes("mastodon") || host.includes("fosstodon")) return { kind: "post", label: "post" };
  if (host.includes("arxiv.org") || host.includes("doi.org")) return { kind: "paper", label: "paper" };
  return { kind: "article", label: "article" };
}

function RoundupCard({ items, hasProfile, onOpen }: { items: Item[]; hasProfile: boolean; onOpen: (item: Item) => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) {
    return <section className="jomo-enter rounded-3xl bg-card/40 px-6 py-12 text-center ring-1 ring-border/40"><Icon name="Check" className="mx-auto size-5 text-emerald-400" /><h2 className="mt-3 text-xl font-medium tracking-tight">All quiet.</h2><p className="mt-2 text-sm text-muted-foreground">The report is tucked away. Everything else is still resting.</p><button type="button" onClick={() => setDismissed(false)} className="mt-5 text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground">Show today&apos;s report</button></section>;
  }
  const roundPicks = [
    items.find((item) => item.id === "mayfly-chat"),
    items.find((item) => item.id === "trinitron"),
    items.find((item) => item.source === "A TARDE"),
  ].filter((item): item is Item => Boolean(item));
  const bullets: Array<{ item: Item; text: string }> = [
    { item: roundPicks[0], text: "Mayfly Chat: transient conversations that leave durable artifacts behind" },
    { item: roundPicks[1], text: "The Trinitron restoration matches your keep-every-retro-repair rule" },
    { item: roundPicks[2], text: roundPicks[2].title ?? "Salvador local news from A TARDE" },
  ];
  return (
    <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-amber-400/[0.07] via-card/70 to-card/40 shadow-sm ring-1 ring-border/50">
      <div className="flex items-center justify-between px-4 pt-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-amber-400">JOMO report · today</p>
        <button type="button" aria-label="Dismiss roundup" onClick={() => setDismissed(true)} className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS + " grid place-items-center text-muted-foreground hover:text-foreground")}><Icon name="X" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /></button>
      </div>
      <div className="px-4 pb-1">
        <p className="text-xl font-medium tracking-tight text-foreground">{hasProfile ? "Nothing appears to need you right now." : "Nothing is asking for attention."}</p>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{hasProfile ? "Three things brushed against the interests in your notebook. They can wait too." : "Three optional curiosities surfaced from the mock hoard. No profile assumptions yet."}</p>
      </div>
      <ul className="mx-2 mt-3 space-y-1 pb-2">
        {bullets.map(({ item, text }) => (
          <li key={item.id}>
            <button type="button" onClick={() => onOpen(item)} className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/40">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ backgroundColor: item.sourceColor }} />
              <span className="min-w-0"><span className="block text-[13px] max-md:pointer-coarse:text-[15px] leading-5">{text}</span><span className="text-[11px] text-muted-foreground">{item.source} · {item.title ?? item.fullName}</span></span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between px-4 py-3 text-[11px] text-muted-foreground">
        <span>Everything else is resting safely out of sight.</span>
        <span className="inline-flex items-center gap-1 opacity-60"><Icon name="Repeat" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> a new report follows each sweep</span>
      </div>
    </section>
  );

}

function SweepView({ items, onOpen, onSet, onExit }: { items: Item[]; onOpen: (item: Item) => void; onSet: (id: string, state: SavedState) => void; onExit: () => void }) {
  const startIndex = Math.max(0, items.findIndex((item) => item.id === lastActedItemId));
  const [index, setIndex] = useState(startIndex);
  const [dx, setDx] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const undoStack = useRef<Array<{ id: string; state: SavedState; label: string }>>([]);
  const lastSet = useRef(onSet);
  lastSet.current = onSet;

  const articleRef = useRef<HTMLElement | null>(null);
  const finished = index >= items.length;
  const item = items[index] as Item;

  const apply = (state: SavedState, advance = true) => {
    const current = items[index];
    if (!current) return;
    undoStack.current.push({ id: current.id, state: current.saved, label: current.title ?? current.fullName ?? "item" });
    lastSet.current(current.id, state);
    lastActedItemId = current.id;
    setToast(`"${current.title ?? current.fullName}" → ${state}`);
    if (advance) setIndex((i) => i + 1);
  };

  const step = (delta: number) => setIndex((i) => Math.max(0, Math.min(items.length - 1, i + delta)));

  // Sweep keys: space/s ingest, backspace/x/d drop, l later, arrows skip,
  // o read, u undo, esc exits the sprint.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "s") { event.preventDefault(); apply("saved"); return; }
      if (event.key === "Backspace" || event.key === "d" || event.key === "x") { event.preventDefault(); apply("dropped"); return; }
      if (event.key === "l") { event.preventDefault(); apply("later"); return; }
      if (event.key === "o" || event.key === "Enter") { const current = items[index]; if (current) { event.preventDefault(); onOpen(current); } return; }
      if (event.key === "ArrowRight") { event.preventDefault(); step(1); return; }
      if (event.key === "ArrowLeft" || event.key === "b") { event.preventDefault(); step(-1); return; }
      if (event.key === "u" || event.key === "z") {
        const prev = undoStack.current.pop();
        if (prev) {
          lastSet.current(prev.id, prev.state);
          const target = items.findIndex((it) => it.id === prev.id);
          if (target >= 0) setIndex(target);
          setToast(`undid: "${prev.label}"`);
        }
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); onExit(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, index]);

  // Match triage-row gesture ownership: keep intentional 32px edge swipes for
  // BB navigation, but claim horizontal card gestures with a non-passive
  // listener before the app shell can turn them into left-nav drags.
  useEffect(() => {
    const el = articleRef.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let edge = false;
    let offset = 0;
    let claimed = false;
    let pointerId: number | null = null;

    const releasePointer = () => {
      if (pointerId !== null) {
        try { el.releasePointerCapture(pointerId); } catch { /* noop */ }
        pointerId = null;
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY };
      edge = touch.clientX < 32 || touch.clientX > window.innerWidth - 32;
      claimed = false;
      if (!edge) event.stopPropagation();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!start) return;
      const horizontal = event.touches[0].clientX - start.x;
      const vertical = event.touches[0].clientY - start.y;
      offset = Math.abs(horizontal) > Math.abs(vertical) ? Math.max(-160, Math.min(160, horizontal)) : 0;
      if (edge) return;
      if (!claimed && Math.abs(horizontal) > 8 && Math.abs(horizontal) > Math.abs(vertical)) claimed = true;
      if (claimed) { event.preventDefault(); event.stopPropagation(); }
      setDx(offset);
    };
    const onTouchEnd = () => {
      if (!edge) {
        if (offset > 130) apply("saved");
        else if (offset < -130) apply("dropped");
      }
      start = null;
      edge = false;
      offset = 0;
      claimed = false;
      releasePointer();
      setDx(0);
    };
    const onPointerDown = (event: PointerEvent) => {
      edge = event.clientX < 32 || event.clientX > window.innerWidth - 32;
      if (edge) return;
      pointerId = event.pointerId;
      try { el.setPointerCapture(event.pointerId); } catch { /* already captured */ }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("pointerdown", onPointerDown);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("pointerdown", onPointerDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, index]);

  if (finished) {
    return (
      <div className="jomo-enter grid min-h-0 flex-1 place-items-center px-5">
        <div className="max-w-md text-center">
          <p className="text-3xl max-md:pointer-coarse:text-4xl font-semibold tracking-tight">That is enough for today.</p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{items.length === 0 ? "There was nothing waiting for a decision." : "The rest can wait. There is no score to improve and nothing to catch up on."}</p>
          <Button variant="outline" size="sm" className="mt-7 h-9 max-md:pointer-coarse:h-10" onClick={onExit}>Let the rest wait</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="jomo-enter flex min-h-[calc(100%-56px)] flex-1 flex-col">
      <div className="px-4 pt-1">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <button type="button" onClick={onExit} className="inline-flex items-center gap-1 hover:text-foreground"><Icon name="ChevronLeft" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> exit sweep</button>
          <span className="font-mono">{index + 1} / {items.length}</span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${Math.round(((index + 1) / items.length) * 100)}%` }} />
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <span className="absolute inset-0 grid place-items-center bg-emerald-500/15 text-sm font-medium text-emerald-400" style={{ opacity: dx > 24 ? Math.min(1, dx / 120) : 0 }}>✓ Ingest</span>
        <span className="absolute inset-0 grid place-items-center bg-muted text-sm font-medium text-muted-foreground" style={{ opacity: dx < -24 ? Math.min(1, -dx / 120) : 0 }}>✕ Drop</span>
        <article
          ref={articleRef}
          className="relative flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-border bg-card p-5 max-md:pointer-coarse:p-6 shadow-lg"
          style={{ touchAction: "pan-y", transform: `translateX(${dx}px)` }}
        >
          <div className="flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground">
            <SourceMark item={item} />
            <span className="min-w-0 truncate font-medium text-foreground">{item.source}</span>
            <span>·</span>
            <span>{item.time}</span>
            <span className="ml-auto rounded-full bg-muted px-2 py-0.5">{KIND_META[item.kind].label}</span>
          </div>
          <button type="button" className="text-left" onClick={() => onOpen(item)}>
            <h2 className="text-2xl max-md:pointer-coarse:text-3xl font-semibold leading-snug tracking-tight">{item.title ?? item.fullName}</h2>
            {(item.body || item.description) ? <p className="mt-2 line-clamp-3 text-sm max-md:pointer-coarse:text-base leading-6 text-muted-foreground">{item.body || item.description}</p> : null}
          </button>
          <div className="flex flex-wrap items-center gap-3 border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
            <span><kbd className="font-mono">space</kbd>/<kbd className="font-mono">s</kbd> ingest & next</span>
            <span><kbd className="font-mono">backspace</kbd> drop</span>
            <span><kbd className="font-mono">l</kbd> later</span>
            <span><kbd className="font-mono">→</kbd> skip</span>
            <span><kbd className="font-mono">o</kbd> read</span>
            <span><kbd className="font-mono">u</kbd> undo</span>
          </div>
        </article>
      </div>
      <div className="sticky bottom-0 border-t border-border bg-background/95 px-4 py-2.5 text-xs text-muted-foreground backdrop-blur">
        {toast ?? "space = ingest & next · backspace = drop · arrows skip past · esc exits"}
        {toast && <button type="button" className="ml-3 underline hover:text-foreground" onClick={() => { const prev = undoStack.current.pop(); if (prev) { lastSet.current(prev.id, prev.state); const target = items.findIndex((it) => it.id === prev.id); if (target >= 0) setIndex(target); setToast(`undid: "${prev.label}"`); } }}>undo</button>}
      </div>
    </div>
  );
}

function SourcesDrawer({ open, onClose, sources, onToggle, onRemove, onAddFeed, onIngest, notice }: {
  open: boolean;
  onClose: () => void;
  sources: Source[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAddFeed: (name: string, url: string) => void;
  onIngest: (url: string) => void;
  notice: string | null;
}) {
  const [tab, setTab] = useState<"links" | "feeds">("links");
  const [feedName, setFeedName] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const feedLooksValid = feedUrl.includes(".") && !feedUrl.includes(" ");
  const linkLooksValid = linkUrl.includes(".") && !linkUrl.includes(" ");

  const askRemove = (id: string) => {
    setConfirmId(id);
    window.setTimeout(() => setConfirmId((current) => (current === id ? null : current)), 5000);
  };

  useEffect(() => {
    if (!open) { setConfirmId(null); return; }
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
          {([["links", "Ingest a link"], ["feeds", "Add a feed"]] as Array<["links" | "feeds", string]>).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={cn("rounded-md px-3 py-1.5 text-xs transition-colors", tab === id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>{label}</button>
          ))}
        </div>

        {notice && <p className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">{notice}</p>}

        {tab === "links" ? (
          <div className="mt-4">
            <label className="text-xs text-muted-foreground" htmlFor="jomo-ingest-url">Paste any URL — jomo captures it as today's queue</label>
            <div className="mt-2 flex gap-2">
              <input
                id="jomo-ingest-url"
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && linkLooksValid) { onIngest(linkUrl); setLinkUrl(""); } }}
                placeholder="https://…"
                className="h-10 flex-1 rounded-lg border border-border bg-card px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-primary"
              />
              <Button size="sm" className="h-10" disabled={!linkLooksValid} onClick={() => { onIngest(linkUrl); setLinkUrl(""); }}>
                <Icon name="Plus" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> Capture
              </Button>
            </div>
            {inference && <p className="mt-2 text-xs text-muted-foreground">Will ingest as <span className="font-medium text-foreground">{inference.label}</span> · landing in today's queue</p>}
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
                className="h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-primary"
              />
              <input
                value={feedName}
                onChange={(event) => setFeedName(event.target.value)}
                placeholder="Optional display name"
                className="h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-primary"
              />
              <Button size="sm" className="h-10" disabled={!feedLooksValid} onClick={() => { onAddFeed(feedName || new URL(feedUrl).hostname, feedUrl); setFeedUrl(""); setFeedName(""); }}>
                <Icon name="Plus" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> Add feed
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Fetching starts paused — first poll happens on the next sweep + n</p>
          </div>
        )}

        <h3 className="mt-6 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Configured · {sources.filter((source) => source.enabled).length} active / {sources.length}</h3>
        <div className="mt-2 space-y-1">
          {sources.map((source) => {
            const kindMeta = SOURCE_KIND_META[source.kind];
            if (confirmId === source.id) {
              return (
                <div key={source.id} className="flex items-center gap-3 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] max-md:pointer-coarse:text-[15px] font-medium text-red-400">Remove "{source.name}"?</p>
                    <p className="text-[11px] text-muted-foreground">Its ingested items stay in the library</p>
                  </div>
                  <button type="button" onClick={() => { setConfirmId(null); onRemove(source.id); }} className={cn(COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS + " border-red-500/60 text-red-400 max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-3")}>Remove</button>
                  <button type="button" onClick={() => setConfirmId(null)} className={cn(COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS + " max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-3")}>Keep</button>
                </div>
              );
            }
            return (
              <div key={source.id} className={cn("flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 hover:bg-muted/40", !source.enabled && "opacity-55")}>
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: source.color }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] max-md:pointer-coarse:text-[15px] font-medium">{source.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground"><Icon name={kindMeta.icon} className="inline size-3" /> {kindMeta.label} · {source.lastFetch}</p>
                </div>
                <button type="button" aria-label="Remove source" onClick={() => (confirmId === source.id ? onRemove(source.id) : askRemove(source.id))} className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS + " grid place-items-center hover:bg-muted", confirmId === source.id ? "text-red-400 bg-red-500/10" : "text-muted-foreground hover:text-foreground")}>
                  <Icon name={confirmId === source.id ? "X" : "Trash2"} className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} />
                </button>
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

const FEED_TABS: Array<[Feed, string]> = [
  ["all", "All"],
  ["articles", "Articles"],
  ["videos", "Videos"],
  ["social", "Social"],
  ["code", "Code"],
  ["saved", "Library"],
];

function JomoPage({ subPath }: { subPath?: string }) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [profile, setProfile] = useState<LibrarianProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileReload, setProfileReload] = useState(0);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [deskOpen, setDeskOpen] = useState(false);
  const [interviewOpen, setInterviewOpen] = useState(false);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [feed, setFeed] = useState<Feed>("all");
  const [items, setItems] = useState(ITEMS);
  const [sources, setSources] = useState(SOURCES);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [view, setView] = useState<"home" | "cards" | "triage" | "sweep">("home");

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

  const completeOnboarding = async (next: LibrarianProfile) => {
    await rpc.call("onboarding_save", next);
    setProfile(next);
    setInterviewOpen(false);
  };

  const saveNotebook = async (notebook: string) => {
    const result = await rpc.call("notebook_save", { notebook });
    if (result.saved) setProfile((current) => current ? { ...current, notebook } : current);
  };

  const activeItem = useMemo(() => {
    const route = decodeURIComponent((subPath ?? "").replace(/^\/+|\/+$/g, ""));
    return route ? items.find((item) => item.id === route) ?? null : null;
  }, [subPath, items]);

  const openItem = (item: Item) => navigate.toPluginPanel("feed", { subPath: item.id });
  const closeReader = () => navigate.toPluginPanel("feed", { replace: true });

  const visible = useMemo(() => {
    const enabled = new Set(sources.filter((source) => source.enabled).map((source) => source.id));
    return items.filter((item) => {
      if (item.sourceId && !enabled.has(item.sourceId)) return false;
      if (!matchesKind(item, feed)) return false;
      if (view === "triage") return true;
      if (feed === "saved") return item.saved === "saved" || item.saved === "later";
      return item.saved !== "dropped";
    });
  }, [feed, view, items, sources]);

  const byDay = useMemo(() => {
    const groups: Array<[string, Item[]]> = [["Today", []], ["Yesterday", []]];
    for (const item of visible) {
      const bucket = item.day === "today" ? groups[0][1] : groups[1][1];
      bucket.push(item);
    }
    return groups.filter(([, items]) => items.length > 0);
  }, [visible]);

  const sweepItems = useMemo(() => {
    const enabled = new Set(sources.filter((source) => source.enabled).map((source) => source.id));
    return items.filter((item) => {
      if (item.sourceId && !enabled.has(item.sourceId)) return false;
      if (!matchesKind(item, feed)) return false;
      return item.saved !== "dropped";
    });
  }, [items, sources, feed]);

  const setState = (id: string, state: SavedState) => setItems((current) => current.map((item) => item.id === id ? { ...item, saved: state } : item));
  const toggleSaved = (id: string) => setItems((current) => current.map((item) => item.id === id ? { ...item, saved: item.saved === "saved" ? "new" : "saved" } : item));

  const flashNotice = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? null : current)), 3600);
  };

  const showNotice = (text: string) => {
    if (drawerOpen) { flashNotice(text); return; }
    setNotice(null);
  };

  const toggleSource = (id: string) => setSources((current) => current.map((source) => source.id === id ? { ...source, enabled: !source.enabled } : source));

  const removeSource = (id: string) => {
    const source = sources.find((entry) => entry.id === id);
    setSources((current) => current.filter((entry) => entry.id !== id));
    if (source) showNotice(`Removed "${source.name}" — its ingested items stay in the library`);
  };

  const addFeed = (name: string, url: string) => {
    let kind: RssSourceKind = "rss";
    try {
      const host = new URL(url).hostname;
      kind = host.includes("github.com") ? "github" : host.includes("youtube.com") ? "youtube" : host.includes("mastodon") || host.includes("fosstodon") || host.includes("social") ? "mastodon" : "rss";
    } catch { /* keep rss */ }
    setSources((current) => [{ id: `feed-${Date.now()}`, name, url, kind, color: colorFromString(name), enabled: false, lastFetch: "paused — first poll pending" }, ...current]);
    showNotice(`Added "${name}" — flip it on when you want fetching to start`);
  };

  const captureLink = (rawUrl: string, saved: SavedState): boolean => {
    const url = rawUrl.trim();
    if (items.some((item) => item.body.includes(url))) return false;
    const { kind } = inferKindFromUrl(url);
    let host = url;
    let slugTail = url;
    try {
      const parsed = new URL(url);
      host = parsed.hostname.replace(/^www\./, "");
      slugTail = parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname;
    } catch { /* keep raw */ }
    const title = slugTail.replace(/[-_]+/g, " ").replace(/\.(html?|xml|md)$/i, "").replace(/\b[a-z]/g, (c) => c.toUpperCase()) || host;
    const sourceName = sourceNameForHost(host);
    const item: Item = {
      id: `adhoc-${Date.now()}-${adHocSequence++}`,
      kind,
      source: sourceName,
      sourceColor: colorFromString(sourceName),
      author: sourceName,
      title,
      body: `${url} — mock capture; no network request was made`,
      time: new Date().toTimeString().slice(0, 5),
      day: "today",
      tags: ["#mock-capture"],
      saved,
      minutes: kind === "video" ? undefined : 6,
      duration: kind === "video" ? "--:-- mock capture" : undefined,
      views: kind === "video" ? "No network request" : undefined,
    };
    setItems((current) => [item, ...current]);
    return true;
  };

  const ingestLink = (rawUrl: string) => {
    const { label } = inferKindFromUrl(rawUrl);
    showNotice(captureLink(rawUrl, "new") ? `Mock ${label} added to today's queue` : "That link is already in the mock hoard");
  };

  const hoardLinks = (urls: string[]) => {
    for (const url of urls) captureLink(url, "saved");
  };

  if (!profileLoaded) return <div className="grid h-full place-items-center bg-background text-sm text-muted-foreground">Waking the librarian…</div>;

  if (profileError && !setupDismissed) {
    return <div className="grid h-full place-items-center bg-background px-5"><div className="max-w-md rounded-2xl border border-border bg-card p-6 text-center"><Icon name="AlertCircle" className="mx-auto size-6 text-amber-400" /><h2 className="mt-3 text-lg font-semibold">The librarian could not open its notebook.</h2><p className="mt-2 text-sm text-muted-foreground">{profileError}</p><div className="mt-5 flex justify-center gap-2"><Button onClick={() => setProfileReload((current) => current + 1)}>Try again</Button><Button variant="outline" onClick={() => setSetupDismissed(true)}>Continue without it</Button></div></div></div>;
  }

  if (interviewOpen || (!profile && !setupDismissed)) {
    return <Onboarding onComplete={completeOnboarding} onSkip={() => { setSetupDismissed(true); setInterviewOpen(false); }} />;
  }

  if (deskOpen) return <LibrarianDesk items={items} onClose={() => setDeskOpen(false)} onOpenItem={(id) => { setDeskOpen(false); const item = items.find((entry) => entry.id === id); if (item) openItem(item); }} onHoardLinks={hoardLinks} onSubscribe={addFeed} />;

  if (activeItem) return <Reader item={activeItem} onBack={closeReader} onToggleSaved={() => toggleSaved(activeItem.id)} />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b border-border px-3 max-sm:pointer-coarse:px-4 py-3 max-sm:pointer-coarse:py-4 sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">jomo</h1>
            <p className="hidden sm:block text-xs text-muted-foreground">{view === "home" ? "The hoard is holding everything. Nothing needs attention." : "Browse only because you want to."}</p>
          </div>
          <div className="relative flex items-center gap-2">
            {view !== "home" && <div className="inline-flex rounded-lg bg-muted/40 p-0.5" role="tablist" aria-label="Hoard view">
              <button type="button" aria-label="Return to calm view" onClick={() => setView("home")} className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS + " grid place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground")}><Icon name="ChevronLeft" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /></button>
              {([
                ["cards", "GridView"],
                ["triage", "ListView"],
                ["sweep", "Zap"],
              ] as Array<["cards" | "triage" | "sweep", "GridView" | "ListView" | "Zap"]>).map(([mode, icon]) => (
                <button key={mode} type="button" aria-pressed={view === mode} aria-label={mode === "cards" ? "Card view" : mode === "triage" ? "Triage view" : "Sweep mode"} onClick={() => setView(mode)} className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS + " grid place-items-center rounded-md transition-colors", view === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  <Icon name={icon} className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} />
                </button>
              ))}
            </div>}
            <button type="button" aria-expanded={utilityOpen} aria-label="Open JOMO menu" onClick={() => setUtilityOpen((current) => !current)} className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS + " grid place-items-center rounded-full bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground")}><Icon name="Explore" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /></button>
            {utilityOpen && <><button type="button" aria-label="Close JOMO menu" className="fixed inset-0 z-30 cursor-default" onClick={() => setUtilityOpen(false)} /><div className="jomo-enter absolute right-12 top-11 z-40 w-60 rounded-2xl bg-card p-1.5 shadow-xl ring-1 ring-border/60"><button type="button" onClick={() => { setUtilityOpen(false); setDeskOpen(true); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-foreground hover:bg-muted"><Icon name="MessageSquare" className="size-4 text-amber-400" /> Talk to the librarian</button><button type="button" onClick={() => { setUtilityOpen(false); setDrawerOpen(true); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><Icon name="Plus" className="size-4" /> Sources & mock capture</button><button type="button" onClick={() => { setUtilityOpen(false); if (profile) setNotebookOpen(true); else setInterviewOpen(true); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><Icon name="Explore" className="size-4" /> {profile ? "Librarian's notebook" : "Meet the librarian"}</button></div></>}
            <Button variant="outline" size="sm" className="h-8 max-md:pointer-coarse:h-10" onClick={() => navigate.toCompose()}><Icon name="GridView" className={COARSE_POINTER_ICON_SIZE_SHRINK_CLASS} /> <span className="hidden sm:inline">Back to BB</span></Button>
          </div>
        </div>
      </header>
      <div className={cn("min-h-0 flex-1", view === "triage" ? "flex flex-col" : "overflow-y-auto pb-[env(safe-area-inset-bottom)]")}>
        <div className={cn("mx-auto w-full max-w-5xl px-3 max-sm:pointer-coarse:px-4 py-4 sm:px-8 sm:py-6", view === "triage" && "flex min-h-0 flex-1 flex-col")}>
          {view !== "home" && <nav aria-label="Feed filters" className={cn("-mx-1 flex gap-1 overflow-x-auto px-1 pb-1", view === "triage" ? "mb-4" : "mb-5")}>
            {FEED_TABS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setFeed(id)} className={cn("shrink-0 rounded-full px-3.5 py-1.5 max-md:pointer-coarse:px-4 max-md:pointer-coarse:py-2 text-[13px] max-md:pointer-coarse:text-sm transition-colors", feed === id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>{label}</button>
            ))}
          </nav>}
          {view === "home" ? (
            <section className="jomo-enter mx-auto max-w-3xl py-5 sm:py-12">
              <RoundupCard items={items} hasProfile={Boolean(profile)} onOpen={openItem} />
              <div className="mt-12 text-center">
                <p className="text-sm text-muted-foreground">The rest of the round is resting in the hoard.</p>
                <p className="mt-1 text-xs text-muted-foreground/70">No badge, no deadline, no need to catch up.</p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  <Button onClick={() => setDeskOpen(true)}><Icon name="MessageSquare" className="size-4" /> Talk to the librarian</Button>
                  <Button variant="outline" onClick={() => setView("cards")}>Browse the hoard</Button>
                  <Button variant="ghost" onClick={() => setView("sweep")}>Take a quiet sweep</Button>
                </div>
              </div>
            </section>
          ) : view === "sweep" ? (
            <SweepView items={sweepItems} onOpen={openItem} onSet={setState} onExit={() => setView("home")} />
          ) : view === "triage" ? (
            <TriageView items={visible} onOpen={(item) => openItem(item)} onSet={setState} activeKindLabel={FEED_TABS.find(([id]) => id === feed)?.[1] ?? "All"} />
          ) : (
            <div className="jomo-enter">
              {byDay.length === 0 && <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Nothing here yet.</p>}
              {byDay.map(([label, dayItems]) => (
                <section key={label} className="mb-2">
                  <h2 className="sticky top-0 z-10 -mx-2 mb-3 bg-background/90 px-2 py-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground backdrop-blur">{label} · {dayItems.length}</h2>
                  <div className="grid items-start gap-3 md:grid-cols-2">
                    {dayItems.map((item) => <ItemCard key={item.id} item={item} onOpen={() => openItem(item)} onSave={() => toggleSaved(item.id)} />)}
                  </div>
                </section>
              ))}
              <p className="mt-8 text-center text-xs text-muted-foreground">Mock material for exploring the shape of a large hoard.</p>
            </div>
          )}
        </div>
      </div>
      {profile && <NotebookPanel profile={profile} open={notebookOpen} onClose={() => setNotebookOpen(false)} onSave={saveNotebook} onReinterview={() => { setNotebookOpen(false); setInterviewOpen(true); }} />}
      <SourcesDrawer
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setNotice(null); }}
        sources={sources}
        onToggle={toggleSource}
        onRemove={removeSource}
        onAddFeed={addFeed}
        onIngest={ingestLink}
        notice={notice}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "jomo", title: "jomo", icon: "Explore", path: "feed", component: JomoPage });
});

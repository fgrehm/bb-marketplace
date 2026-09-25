import type { Icon } from "@/components/ui/icon";

export type ItemKind = "article" | "video" | "post" | "repo" | "release" | "paper";

export type SavedState = "new" | "later" | "saved" | "dropped";

export type Item = {
  id: string;
  kind: ItemKind;
  source: string;
  sourceId?: string;
  sourceColor: string;
  author: string;
  title?: string;
  body: string;
  url?: string;
  contentState?: string;
  expiresAt?: number | null;
  time: string;
  day: "today" | "yesterday" | "older";
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

export const KIND_META: Record<ItemKind, { label: string; icon: React.ComponentProps<typeof Icon>["name"] }> = {
  article: { label: "Article", icon: "FileText" },
  video: { label: "Video", icon: "Play" },
  post: { label: "Post", icon: "MessageSquare" },
  repo: { label: "Repo", icon: "GithubLogo" },
  release: { label: "Release", icon: "GitBranch" },
  paper: { label: "Paper", icon: "Beaker" },
};

export const STATE_MARK: Record<SavedState, { icon: null | React.ComponentProps<typeof Icon>["name"]; ring: string; dot: string }> = {
  new: { icon: null, ring: "border ring-muted-foreground/40", dot: "" },
  later: { icon: "Clock", ring: "bg-amber-400/15 border-amber-400/60 text-amber-400", dot: "" },
  saved: { icon: "Check", ring: "bg-emerald-500/15 border-emerald-500/60 text-emerald-400", dot: "" },
  dropped: { icon: "X", ring: "bg-muted border-transparent text-muted-foreground", dot: "" },
};

export const STATE_ACCENT: Record<SavedState, string> = {
  new: "",
  later: "border-l-amber-400",
  saved: "border-l-emerald-500",
  dropped: "border-l-transparent opacity-45",
};

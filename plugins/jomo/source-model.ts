import type { Icon } from "@/components/ui/icon";
import type { ItemKind } from "./item-model";

export type RssSourceKind = "rss" | "mastodon" | "github" | "youtube";

export type Source = {
  id: string;
  name: string;
  url: string;
  kind: RssSourceKind;
  color: string;
  enabled: boolean;
  lastFetch: string;
};

export const SOURCE_KIND_META: Record<RssSourceKind, { label: string; icon: React.ComponentProps<typeof Icon>["name"] }> = {
  rss: { label: "RSS feed", icon: "Globe" },
  mastodon: { label: "Account", icon: "MessageSquare" },
  github: { label: "GitHub", icon: "GithubLogo" },
  youtube: { label: "YouTube", icon: "Play" },
};

export function colorFromString(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) & 0xffffff;
  const hue = hash % 360;
  return `hsl(${hue} 62% 52%)`;
}

export function inferKindFromUrl(rawUrl: string): { kind: ItemKind; label: string } {
  let host = "";
  try { host = new URL(rawUrl).hostname; } catch { return { kind: "article", label: "link" }; }
  if (host.includes("github.com")) return { kind: "repo", label: "repo" };
  if (host.includes("youtube.com") || host === "youtu.be") return { kind: "video", label: "video" };
  if (host.includes("x.com") || host.includes("twitter.com") || host.includes("mastodon") || host.includes("fosstodon")) return { kind: "post", label: "post" };
  if (host.includes("arxiv.org") || host.includes("doi.org")) return { kind: "paper", label: "paper" };
  return { kind: "article", label: "article" };
}

import type { Item } from "./item-model";

export type ItemRow = { id: string; sourceId: string | null; source: string; sourceColor: string; kind: string; author: string | null; title: string; excerpt: string; url: string | null; publishedAt: number; tags: string; state: "new" | "later" | "saved"; contentState: string; expiresAt: number | null };

export function toItem(row: ItemRow): Item {
  const published = new Date(row.publishedAt * 1000);
  // Preserve the stored kind for filters. Cards without kind-specific extras use the generic article preview.
  const kind = (["article", "video", "post", "repo", "release", "paper"] as const).find((value) => value === row.kind) ?? "article";
  return {
    id: row.id,
    kind,
    source: row.source,
    sourceId: row.sourceId ?? undefined,
    sourceColor: row.sourceColor,
    author: row.author ?? row.source,
    title: row.title,
    body: row.excerpt,
    url: row.url ?? undefined,
    time: published.toLocaleDateString(),
    day: published.toDateString() === new Date().toDateString() ? "today" : published.toDateString() === new Date(Date.now() - 86400000).toDateString() ? "yesterday" : "older",
    tags: JSON.parse(row.tags) as string[],
    saved: row.state,
    contentState: row.contentState,
    expiresAt: row.expiresAt,
  };
}

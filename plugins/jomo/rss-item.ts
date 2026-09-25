import type { Item } from "./item-model";
import { toHoardItem } from "./hoard-item";
import { colorFromString } from "./source-model";

export type RssReviewRow = { id: string; source: string; kind: string; title: string; author: string | null; excerpt: string; url: string; publishedAt: number };

// Staged entries have excerpts, not extracted bodies or kind-specific metadata.
// Render every one with the generic article card until it is saved and extracted.
export function toRssItem(row: RssReviewRow): Item {
  return toHoardItem({ ...row, sourceId: null, sourceColor: colorFromString(row.source), kind: row.kind, tags: "[]", state: "new", contentState: "staged", expiresAt: null });
}

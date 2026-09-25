import type { Item } from "../item-model";
import { ArticleCard } from "./article-card";
import { VideoCard } from "./video-card";
import { PostCard } from "./post-card";
import { RepoCard } from "./repo-card";
import { ReleaseCard } from "./release-card";
import { PaperCard } from "./paper-card";

export function ItemCard({ item, onOpen, onSave }: { item: Item; onOpen: () => void; onSave: () => void }) {
  // RSS previews do not include the fields needed by the specialized cards.
  if (((item.kind === "repo" || item.kind === "release") && !item.fullName) || (item.kind === "video" && !item.duration) || (item.kind === "post" && !item.handle)) return <ArticleCard item={item} onOpen={onOpen} onSave={onSave} />;
  switch (item.kind) {
    case "video": return <VideoCard item={item} onOpen={onOpen} onSave={onSave} />;
    case "post": return <PostCard item={item} onOpen={onOpen} onSave={onSave} />;
    case "repo": return <RepoCard item={item} onOpen={onOpen} onSave={onSave} />;
    case "release": return <ReleaseCard item={item} onOpen={onOpen} onSave={onSave} />;
    case "paper": return <PaperCard item={item} onOpen={onOpen} onSave={onSave} />;
    default: return <ArticleCard item={item} onOpen={onOpen} onSave={onSave} />;
  }
}

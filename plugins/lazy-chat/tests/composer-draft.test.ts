import { describe, expect, it } from "vitest";
import type { ComposerDraftSnapshot } from "@get-bb/plugin-sdk/app";
import { replaceComposerText } from "../composer-draft";

const threadMention = (from: number, to: number, threadId: string) => ({
  kind: "thread" as const,
  from,
  to,
  label: `@${threadId}`,
  threadId,
});

function draft(
  text: string,
  mentions: ComposerDraftSnapshot["mentions"],
  attachments: ComposerDraftSnapshot["attachments"],
): ComposerDraftSnapshot {
  return { text, mentions, attachments };
}

describe("replaceComposerText", () => {
  it("preserves mentions outside the changed span and rebases following ranges", () => {
    const original = draft(
      "@before old @after",
      [threadMention(0, 7, "before"), threadMention(12, 18, "after")],
      [],
    );

    expect(replaceComposerText(original, "@before new longer @after")).toEqual({
      text: "@before new longer @after",
      mentions: [threadMention(0, 7, "before"), threadMention(19, 25, "after")],
    });
  });

  it("preserves an untouched mention between multiple text edits", () => {
    const original = draft(
      "left @thread right",
      [threadMention(5, 12, "thread")],
      [],
    );

    expect(replaceComposerText(original, "LEFT @thread RIGHT")).toEqual({
      text: "LEFT @thread RIGHT",
      mentions: [threadMention(5, 12, "thread")],
    });
  });

  it("drops mentions whose text range was edited and preserves attachments", () => {
    const attachment = {
      name: "notes.txt",
      type: "localFile" as const,
      mimeType: "text/plain",
      sizeBytes: 12,
      path: "/thread-storage/notes.txt",
    } as ComposerDraftSnapshot["attachments"][number];
    const original = draft(
      "keep @edited and @after",
      [threadMention(5, 12, "edited"), threadMention(17, 23, "after")],
      [attachment],
    );

    const replacement = replaceComposerText(
      original,
      "keep replacement and @after",
    );
    expect(replacement).toEqual({
      text: "keep replacement and @after",
      mentions: [threadMention(21, 27, "after")],
    });
    expect(replacement).not.toHaveProperty("attachments");
  });
});

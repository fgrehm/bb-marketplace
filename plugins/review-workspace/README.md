# Review Workspace

A BB plugin for asynchronous, diff-first reviews inside a thread.

Review Workspace loads the thread environment's uncommitted Git diff, lets a reviewer select exact old/new line ranges with Pierre, and sends unsent, unresolved feedback to the agent in the parent thread. Long paths are compacted for display with home-directory abbreviation and leading-segment compaction.

The composer is a single freeform text box; comments render inline with the diff and are sent to the agent as-is in the batch, together with the diff hunks covering the commented lines (context included, capped in size). Each file can also have **file-level comments** anchored to the whole file (no line), shown in a card above its diff and threads/resolvable/sendable like any other comment; the batch panel has a **review note** for the changeset as a whole, sent with every batch. The agent can also add file-level comments via `review_workspace_comment` with `fileLevel: true`.

## Review workflow

1. Open **Review changes** from a thread panel.
2. Pick a target next to Refresh: **Uncommitted** (default), **Commit** (by sha), or **Branch vs base** (committed changes relative to a base branch such as `main`). Each refresh creates an immutable revision labeled with its target.
3. Select a revision and changed file. Filter files by **All**, **Unviewed**, or **With open comments**, and search by path. File counts show unresolved root threads, including inline and file-level comments, with replies counted as part of their thread. On mobile, the same search and filters are available above the changed-file selector.
4. Select lines in the diff gutter and add an anchored comment. Existing comments render inline with the diff. Reply to inline AI-authored comments directly from the diff; a reply to an AI reply is added to its existing root thread. New comment, reply, and edit boxes take focus when they open and submit with `Ctrl+Enter` (`Cmd+Enter` on macOS), with the button still available. Adding a comment saves it to the review, not to the agent; failed saves keep the draft and show an error beside the editor. File-level replies remain in the file comments card. Threads have one top-level comment with flat replies. Human comments can be edited or deleted until they are sent: **Edit** and **Delete** are hidden on AI-authored and sent comments, and **Delete** is disabled on a comment that has replies, which must be removed with their thread. Resolving a comment resolves its whole thread, and threads are carried to the next revision together. The locate button on any feedback comment jumps to its file and scrolls the comment into view.
5. Expand collapsed unchanged context with Pierre's line-info controls when the immutable snapshot has complete text contents. Binary, oversized, and truncated files remain non-expandable.
6. Mark changed files as viewed. Viewed state is stored separately for each immutable revision.
7. Open **Review feedback** to read your open comments and the review note. The button shows how many comments are pending. Resolved threads are folded into a **Resolved** list, and there is nothing to select: on mobile, use **Feedback** in the bottom navigation.
8. Choose **Send comments to agent**. All your unsent, unresolved comments go in one batch, and the agent also receives each thread's AI comment as context. Sending waits for the latest review note to be saved and returns you to the thread on success. If saving or sending fails, the drawer keeps your feedback and shows the error next to the send button so you can retry.
9. After the agent revises, refresh the review to create the next snapshot.

Each refresh creates an immutable review revision. Comments stay anchored to the revision and snapshot that produced them; they are never silently remapped onto a later diff. When a refresh produces a new snapshot, open feedback is **auto-carried** into it: unresolved comment threads (badged "carried", authorship and reply structure preserved) and the review note are copied to the new revision. Resolved comments and older revisions stay untouched. Earlier revisions remain available from the revision picker. Comments can be resolved or reopened explicitly.

The workspace sends anchored comments and the optional review note through the existing `sendBatch` contract. Review-level verdicts are not supported.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run coverage
bb plugin dev   # rebuild + hot-reload on every save

# for release/install:
bb plugin build
bb plugin install . --yes
bb plugin reload review-workspace
```

`@pierre/diffs` is supplied by BB's plugin runtime. See [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) for the current BB host worker-theme limitation.

## Agent tools

The plugin registers agent tools. They are always registered and become available to threads from the next provider session start; a plugin can narrow its own selection per session via `bb.agents.configure`, which this plugin does not do:

- `review_workspace_refresh` - create a new review revision snapshot: uncommitted changes by default, a single commit by sha, or committed branch changes relative to a merge-base branch. Agents call this to prepare a review session (including on already committed code) before a human opens Review changes.
- `review_workspace_status` - changed files and unresolved comments (line-anchored and file-level) for the latest revision.
- `review_workspace_comment` - add a line-anchored comment to the latest revision.
- `review_workspace_resolve` - resolve or reopen a comment by id (e.g. after applying the feedback).
- `review_workspace_history` - list recent review revisions from other threads in the same project, marking those that share the calling thread's environment/checkout. Reviews stay thread-scoped; this is the discovery step for pulling in prior feedback.
- `review_workspace_import` - copy unresolved comments from a listed revision (same project only) into the calling thread's latest revision, keeping comment threads intact via id remapping. Call `review_workspace_refresh` first so imported comments anchor to a diff.

# Review Workspace

A BB plugin for asynchronous, diff-first reviews inside a thread.

Review Workspace loads the thread environment's uncommitted Git diff, lets a reviewer select exact old/new line ranges with Pierre, and sends a selected batch of feedback to the agent in the parent thread. Long paths are compacted for display with home-directory abbreviation and leading-segment compaction.

The composer is a single freeform text box; comments render inline with the diff and are sent to the agent as-is in the batch, together with the diff hunks covering the commented lines (context included, capped in size). Each file can also have **file-level comments** anchored to the whole file (no line), shown in a card above its diff and threads/resolvable/sendable like any other comment; the batch panel has a **review note** for the changeset as a whole, sent with every batch. The agent can also add file-level comments via `review_workspace_comment` with `fileLevel: true`.

## Review workflow

1. Open **Review changes** from a thread panel.
2. Pick a target next to Refresh: **Uncommitted** (default), **Commit** (by sha), or **Branch vs base** (committed changes relative to a base branch such as `main`). Each refresh creates an immutable revision labeled with its target.
3. Select a revision and changed file. On mobile, both selectors are in the header.
4. Select lines in the diff gutter and add an anchored comment. Existing comments render inline with the diff. Comments are threaded Slack-style: one top-level comment with flat replies (use **Reply** on any card, agent comments included). Resolving a comment resolves its whole thread, and threads are carried to the next revision together. The locate button on any sidebar comment jumps to its file and scrolls the comment into view.
5. Expand collapsed unchanged context with Pierre's line-info controls when the immutable snapshot has complete text contents. Binary, oversized, and truncated files remain non-expandable.
6. Mark changed files as viewed. Viewed state is stored separately for each immutable revision.
7. Select unresolved comments in the feedback batch.
8. Choose **Send comments to agent**.
9. After the agent revises, refresh the review to create the next snapshot.

Each refresh creates an immutable review revision. Comments stay anchored to the revision and snapshot that produced them; they are never silently remapped onto a later diff. When a refresh produces a new snapshot, open feedback is **auto-carried** into it: unresolved comment threads (badged "carried", authorship and reply structure preserved) and the review note are copied to the new revision. Resolved comments and older revisions stay untouched. Earlier revisions remain available from the revision picker. Comments can be resolved or reopened explicitly.

The workspace currently sends selected anchored comments through the existing `sendBatch` contract. Review-level verdicts and overall summaries are intentionally not persisted or sent yet, and are follow-up work rather than new semantics added to that contract.

## Experimental: changes by entity (sem)

The plugin ships an optional, fully experimental "Entities" toggle in the file header, isolated from the review flow above. When enabled, entity-level changes (functions, classes, methods) across the whole revision are computed with [sem](https://github.com/Ataraxy-Labs/sem) (`@ataraxy-labs/sem` dependency) and shown as a single revision-level "Changes by entity" summary above the diff, ordered by review priority (deleted/moved/renamed first, then modified, then added). Rows expand into a transitive impact list (dependents + affected tests), and a target button jumps to the entity's lines in the diff when its range has visible lines; jumps without a visible anchor are reported as a miss instead of silently doing nothing.

- Data is computed from the revision's immutable snapshot contents via `sem diff --stdin --format json`. sem never touches git, so results are identical across threads reviewing the same snapshot and stay stable across refreshes.
- The whole revision is computed with a single sem run on first use, cached per (review revision, file) in a `review_entities` table, shared across concurrent callers, and swept when revisions are cleared.
- Binary resolution: prefers `SEM_BIN_PATH`, falls back to the vendored binary from `@ataraxy-labs/sem/vendor/sem` (installed via npm postinstall).
- If sem cannot run, the panel shows a "sem is unavailable" reason and every other review path is unaffected; the `entitySummary` rpc returns `status: "unavailable"` instead of throwing.

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

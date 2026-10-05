# Lazy Chat

A BB plugin that renders a multiline reply editor inside an assistant message directive. It shares BB's thread composer and native submit pipeline, and autosaves each reply round as Markdown in the thread's resolved workspace.

## Use

The assistant must include a completed directive in its message:

```text
::lazy-reply{}
```

The editor is enabled only when the composer scope matches the directive's thread and a server-side check confirms the message is the current completed top-level assistant contribution. The native composer remains visible. Displaced completed rounds can show their own saved reply read-only. The quote probe button is temporary instrumentation.

## Draft persistence

For each validated reply round, Lazy Chat stores Markdown under `.lazyai/bb/<thread-id>/<turn-id>/contribution.md` and `draft.md` in the workspace path resolved from that thread's BB environment. The server supplies the host and root, and uses BB's SDK file API with create-only contribution writes and SHA-256 compare-and-swap draft updates. Persistence requires a ready, active environment with an available workspace path; there is no server-local fallback, and unsupported environments report that drafts are not persisted.

Edits autosave after a short debounce, newer edits queue behind in-flight saves, and a flush of the captured round text is started when the card unmounts or its composer scope changes. Reopening the same round loads its saved Markdown draft. If a saved reply conflicts with different native composer text or a concurrent disk update, both versions are preserved and the user chooses which to keep. A successful local composer submission pauses autosave so the native clear does not erase the saved reply; this does not confirm provider delivery or provide exactly-once recovery.

Markdown restores plain text only. It does not restore structured native mentions or attachments. Ordinary edits continue through the native composer `updateText` API, preserving its existing structured metadata. Earlier root assistant rows within one turn cannot own separate files because the store path is turn-scoped; only that turn's validated final root contribution can load or save. Historical rounds do not mutate the current composer.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run format
pnpm run lint
bb plugin build
```

The live acceptance script sends nothing by default: `pnpm run live-test` exits before launching a browser unless both explicit flags are supplied. A reviewed acceptance run is opted into with `pnpm run live-test -- --prepare --send` and must run from a BB agent context with a valid `BB_THREAD_ID`, which BB includes as the seed request's sender attribution. Before the first provider call, the script reads the selected fixture by ID and requires the exact visible, non-archived, non-deleted, idle thread to be a detached root (`parentThreadId === null`). It rechecks and preserves that identity, including root status, immediately before the seed and after preparation. Do not point it at a child thread; the default fixture must remain detached/root. It then makes exactly one bounded no-tools seed request using `openai-codex/gpt-6-luna`, default service tier, low reasoning, and the existing permission mode. It verifies the mapped successful turn, no tool calls, and the latest root assistant contribution's exact seed text plus `::lazy-reply{}`. This reseeds the card on every authorized run instead of relying on a stale contribution. No automatic retry or extra seed is issued.

Only after seed verification does the script snapshot user request IDs, before browser setup or draft editing. It navigates by the current title returned by `bb thread show --json`, requires one visible exact-title role=link, and asserts the resulting route and rendered thread identity. The mention picker must have exactly one active row with full title `Workspace: plugins/lazy-chat/package.json` before Enter is pressed. Immediately before the one intentional inline send, it rejects and reports any request that appeared during setup. It then requires exactly one new request and correlates its ID through `turn/input/accepted.data.clientRequestId` to a turn-scoped accepted turn ID and that exact turn's successful completion. An incomplete or ambiguous mapping fails closed. The maximum provider-call budget is two dispatches per opted-in run, one seed and one inline send; neither is retried. Do not run the opted-in command until a reviewer authorizes the acceptance run and the fixture is prepared/idle. Read-only checks (`bb thread show`, `bb thread log`, package tests) do not send provider requests.

Override `LAZY_CHAT_FIXTURE_THREAD` and `LAZY_CHAT_SEED_TEXT` only for another prepared fixture. The script verifies submitted text, structured mention, local-file attachment, response, and execution settings, then reloads the thread to check transcript visibility. It saves screenshots under `.agents/scratchpad/lazyai-bb-wireframes/execution/phase0-live/` by default. Queued submissions are not exercised.

Live acceptance attempts on earlier revisions stopped before inline submission; no current-revision browser/live pass has been run. Earlier screenshots and accepted-request evidence do not verify this revision. The live suite is deferred and package unit tests are the current gate; revisit live coverage later. A dedicated page, similar to Review Workspace, is an approved fallback if inline interaction blocks later work. Compatibility is pinned to SDK 0.5.29. Persistence covers Markdown text and the same validated thread/turn/message identity; it does not prove atomic eligibility-to-send binding or exactly-once delivery. Server lifecycle events publish best-effort same-thread invalidation signals; a connected mounted card disables and rechecks ownership when one arrives, and reconnect triggers another recheck. Each inline text edit, quote action, and native submission also awaits a fresh server eligibility check and confirms the same message, thread scope, activity revision, and mounted component before mutating the composer. Missed signals do not authorize writes because the per-operation check is authoritative. The eligibility RPC and composer operation are still separate, non-atomic calls, so activity can race the operation after the check. The earlier-revision accepted request demonstrates only that revision's observed bridge, not current-revision behavior or exactly-once delivery. Stable submission correlation, double-submit/recovery handling, and an atomic turn-bound host operation remain Phase 2 safety work.

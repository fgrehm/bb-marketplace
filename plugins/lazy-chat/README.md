# Lazy Chat

A BB plugin that renders an isolated multiline reply editor inside an assistant message directive. It stores reply history in BB-managed per-thread storage and stages text in BB's native composer only when the user explicitly sends.

## Use

The assistant must include a completed directive in its message. Lazy Chat displays the assistant message text without the directive as reply context. Supply a concise `context` attribute to override that fallback:

```text
::lazy-reply{context="What should we prioritize next?"}
```

The editor is enabled only when the composer scope matches the directive's thread and a server-side check confirms the message is the current completed top-level assistant contribution. Typing and autosaving stay inside Lazy Chat. Click **Send reply** or press **Ctrl+Enter** in the reply editor to use BB's native submit pipeline. If the main composer contains text, mentions, or attachments, send is blocked and the user must clear the composer first; its contents are left untouched. Displaced completed rounds can show their own saved reply read-only.

## Draft persistence

Each thread has one durable Markdown journal at `.lazyai/bb/conversation.md` and, while a reply round is active, one temporary `.lazyai/bb/current.md`. Both live under the root returned by BB's `threads.storageLocation` API, not in the project workspace. Records use versioned metadata and exact-length-delimited Markdown bodies so arbitrary contribution and reply text is retained verbatim. The current file is updated with SHA-256 compare-and-swap. When a new round becomes active, the previous current record is merged idempotently into the journal, verified by read-back, then removed only after a CAS-protected consolidation marker prevents stale writers from replacing it. A failed cleanup leaves recoverable current state for retry; there is no age-based pruning.

Legacy `.lazyai/bb/<thread-id>/<turn-id>/{contribution.md,draft.md}` project-workspace files are discovered only under that thread's old directory, merged into the journal and verified, then removed individually only after a matching-hash CAS tombstone. Conflicting, malformed, truncated-list, or partially migrated records are retained. Other thread directories are not migrated or removed.

Edits autosave after a short debounce, newer edits queue behind in-flight saves, and a flush of the captured round text is started when the card unmounts or its composer scope changes. Reopening a round loads its current or journaled reply. If a reply conflicts with a concurrent storage update, both versions are preserved and the user chooses which to keep. A successful local composer submission pauses autosave so native clearing does not erase the saved reply. As timeline rows are observed, the journal also stores exact BB user-message text independently, keyed by BB message ID with source sequence bounds and the observed turn-request status. It does not correlate that message to a plugin draft from matching text or timing. The journal labels preserved reply text as unfinished; BB transcript/history remains authoritative for what was actually sent or delivered, and this persistence does not provide exactly-once recovery.

Markdown restores plain text only. It does not restore structured native mentions or attachments. The inline reply remains independent of native mentions and attachments until explicit send; the send guard prevents staging while the native composer contains any content. Earlier root assistant rows within one turn cannot own separate current records because the temporary file is per thread; only the validated final root contribution can be actively edited. Historical rounds do not mutate the current composer.

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

Live acceptance attempts on earlier revisions stopped before inline submission; no current-revision browser/live pass has been run. Earlier screenshots and accepted-request evidence do not verify this revision. The live suite is deferred and package unit tests are the current gate; revisit live coverage later. A dedicated page, similar to Review Workspace, is an approved fallback if inline interaction blocks later work. Compatibility requires BB 0.45 or later and Plugin SDK 0.6.15 or later. Persistence covers Markdown text and the same validated thread/turn/message identity; it does not prove atomic eligibility-to-send binding or exactly-once delivery. Server lifecycle events publish best-effort same-thread invalidation signals; a connected mounted card disables and rechecks ownership when one arrives, and reconnect triggers another recheck. Each inline text edit and native submission also awaits a fresh server eligibility check and confirms the same message, thread scope, activity revision, and mounted component before mutating the composer. Missed signals do not authorize writes because the per-operation check is authoritative. The eligibility RPC and composer operation are still separate, non-atomic calls, so activity can race the operation after the check. The earlier-revision accepted request demonstrates only that revision's observed bridge, not current-revision behavior or exactly-once delivery. Stable submission correlation, double-submit/recovery handling, and an atomic turn-bound host operation remain Phase 2 safety work.

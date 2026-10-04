# Lazy Chat

A BB plugin that renders a multiline reply editor inside an assistant message directive. The editor uses BB's thread composer draft and submits through BB's native composer pipeline. This Phase 0 package is an integration proof, not durable draft storage or the complete lazy-chat workflow.

## Use

The assistant must include a completed directive in its message:

```text
::lazy-reply{}
```

The editor is enabled only when the composer scope matches the directive's thread and a server-side check confirms the message is the current completed top-level assistant contribution. The native composer remains visible. The quote probe button is temporary Phase 0 instrumentation.

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

The current-revision live proof has not been run. Existing screenshots and accepted-request evidence are from an earlier revision and do not verify the guarded script on this tree. Full Phase 0 remains open. The plugin uses experimental composer submission APIs from the SDK shipped by BB; compatibility is pinned to SDK 0.5.29. Drafts are not persisted if the plugin card unmounts or BB reloads. Server lifecycle events publish best-effort same-thread invalidation signals; a connected mounted card disables and rechecks ownership when one arrives, and reconnect triggers another recheck. Each inline text edit, quote action, and native submission also awaits a fresh server eligibility check and confirms the same message, thread scope, activity revision, and mounted component before mutating the composer. Missed signals do not authorize writes because the per-operation check is authoritative. The eligibility RPC and composer operation are still separate, non-atomic calls, so activity can race the operation after the check. The earlier-revision accepted request demonstrates only that revision's observed bridge, not current-revision behavior or exactly-once delivery. Stable submission correlation, double-submit/recovery handling, and an atomic turn-bound host operation remain Phase 2 safety work.

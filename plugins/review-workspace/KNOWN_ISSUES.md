# Known issues

- Pierre's worker-rendered diff theme can differ from the host theme in some BB views. The plugin disables the worker pool to keep line selection and rendering consistent; large diffs may therefore render more slowly.
- Review snapshots are immutable. Refreshing creates a new revision and automatically carries unresolved comment threads and the review note forward. Resolved comments stay on their original revision; comments are never silently remapped.
- Safe raster images (PNG, JPEG, WebP, GIF, BMP) can show bounded immutable old/new previews and accept file-level comments. Other binary formats remain file-level only. Image sides that the environment cannot provide show an unavailable state.
- A refresh includes at most 100 changed files. Individual patches may be truncated by the environment API. Since-viewed comparisons with missing identities, truncated sides, or incompatible bases are marked unknown rather than unchanged.
- Large and selected generated patches are deferred from the initial review payload, but are still captured by the environment API before they can be loaded on demand.

## Manual checks

After installing or reloading the plugin, open a thread with uncommitted changes and verify the tour rail, shared scope, old/new keyboard range navigation, deferred patch loading, image fallbacks, comment carry-forward, and explicit batch send in desktop and narrow layouts. Verify that keyboard navigation alone never advances viewed state.

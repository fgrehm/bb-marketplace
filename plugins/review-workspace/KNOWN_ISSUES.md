# Known issues

- Pierre's worker-rendered diff theme can differ from the host theme in some BB views. The plugin disables the worker pool to keep line selection and rendering consistent; large diffs may therefore render more slowly.
- Review snapshots are immutable. Refreshing creates a new revision and automatically carries unresolved comment threads and the review note forward. Resolved comments stay on their original revision; comments are never silently remapped.
- Safe raster images (PNG, JPEG, WebP, GIF, BMP) can show bounded immutable old/new previews and accept file-level comments. Other binary formats remain file-level only. Image sides that the environment cannot provide show an unavailable state.
- Files mode mounts each file's diff only as it approaches the viewport, so a very large review shows a short placeholder until you scroll near that file. Scrolling to a file through navigation mounts it immediately.
- Older tour payloads using per-step body/anchors/card are retained but not displayed by the block-based renderer. Author a new tour on the same revision if needed; saved files and comments remain accessible.
- Files mode renders the current scope as a continuous document, while path search and comment/viewed filters narrow navigation only. Tour mode shows one selected logical section at a time.
- A refresh includes at most 100 changed files. Individual patches may be truncated by the environment API. Since-viewed comparisons with missing identities, truncated sides, or incompatible bases are marked unknown rather than unchanged.
- Large and selected generated patches are deferred from the initial review payload, but are still captured by the environment API before they can be loaded on demand.

## Manual checks

After installing or reloading the plugin, open a thread with uncommitted changes and verify Files/Tour switching, continuous file navigation, ordered cross-file excerpts, shared scope, old/new keyboard range navigation, per-file feedback and viewed controls, deferred patch loading, image fallbacks, comment carry-forward, and explicit batch send in desktop and narrow layouts. Verify that keyboard navigation alone never advances viewed state.

# Known issues

## Review behavior

- Review snapshots are immutable. Refreshing creates a new revision and carries unresolved comment threads and the review note forward. Resolved comments stay on their original revision; comments are never silently remapped.
- Tours stored with the retired per-step body/anchors/card format remain preserved but are not rendered by the current block-based Tour view. Author a new tour on that revision if needed; files and comments remain accessible.
- A refresh includes at most 100 changed files. The environment API may truncate individual patches. Since-viewed comparisons with missing identities, truncated sides, or incompatible bases are marked unknown rather than unchanged.

## Diff limitations

- Large and selected generated patches are captured in the snapshot but deferred from the initial review payload and loaded on demand.
- Files mode mounts diffs as they approach the viewport. Until then, a short placeholder is shown; selecting a file in navigation mounts it immediately.
- Pierre's worker-rendered diff theme can differ from the host theme in some BB views. The plugin disables its worker pool to keep line selection and rendering consistent, so large diffs may render more slowly.
- Safe raster images (PNG, JPEG, WebP, GIF, BMP) can show bounded immutable old/new previews and accept file-level comments. Other binary formats remain file-level only. A side that the environment cannot provide shows as unavailable.

## Review checks

Files mode shows the current scope as a continuous document. Path search and comment/viewed filters narrow navigation only. Tour mode shows one selected logical section at a time. Keyboard navigation alone never advances viewed state.

After installing or reloading the plugin, check Files/Tour switching, file navigation while scrolling and via the picker, mark-viewed collapse and expansion, old/new keyboard range selection, per-file feedback, deferred patch loading, image fallbacks, comment carry-forward, and explicit batch send in desktop and narrow layouts.

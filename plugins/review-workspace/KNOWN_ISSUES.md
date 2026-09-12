# Known issues

- Pierre's worker-rendered diff theme can differ from the host theme in some BB views. The plugin disables the worker pool to keep line selection and rendering consistent; large diffs may therefore render more slowly.
- Review snapshots are immutable. Refreshing creates a new revision, and comments from older revisions must be carried forward explicitly.
- Binary files are listed but cannot be annotated.
- A refresh includes at most 100 changed files. Individual patches may be truncated by the environment API.

## Manual checks

After installing or reloading the plugin, open a thread with uncommitted changes and verify that selecting a diff range, adding a comment, carrying comments to a refreshed revision, and sending a batch all work in both desktop and narrow layouts.

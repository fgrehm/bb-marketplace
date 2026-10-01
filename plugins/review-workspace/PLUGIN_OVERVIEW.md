Review Workspace opens an integrated review panel in a BB thread with a changed-file list, operation summaries, full diffs, and revision-scoped walkthroughs. Create immutable snapshots of uncommitted changes, a selected commit, committed changes against a base branch, or all changes against a base branch. Navigate with Vim-style keys or enter any exact visible old/new line range. Compare against each file's latest explicitly viewed revision, add file-level feedback or an overall review note, and send unsent unresolved comments only when requested. Unresolved comment threads and the review note carry forward when you refresh; tours and their exact anchors stay with their original revision.

Resume existing reviews from the sidebar's Recent reviews page, with the latest saved snapshot per thread, pending-comment counts, and viewed-file progress. Opening a review or reloading this list does not refresh the diff or send feedback.

## Requirements and limits

The review uses Git changes available in the thread environment. Large and generated diffs load on demand. Safe raster previews use immutable captured image bytes; other binary files remain file-level only. Agent-authored tour cards are explanatory and are labeled as unverified where appropriate. Review feedback is sent to the agent in the thread only after explicit confirmation.

Review data, including unsent feedback, is automatically and irreversibly purged after seven days continuously archived or when its BB thread is deleted. Existing archives are included. Cleanup runs on load and hourly while enabled, in bounded batches; active reviews and comments already imported into other threads are retained.

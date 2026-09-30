Review Workspace opens a diff-first review panel in a BB thread. Create immutable snapshots of uncommitted changes, a selected commit, or committed changes against a base branch. Select exact old or new diff lines, add file-level feedback or an overall review note, mark files as viewed, and send all unsent, unresolved human feedback to the agent with relevant diff context. Unresolved comment threads and the review note carry forward when you refresh to a new snapshot; earlier revisions remain available.

Resume existing reviews from the sidebar's Recent reviews page, with the latest saved snapshot per thread, pending-comment counts, and viewed-file progress. Opening a review or reloading this list does not refresh the diff or send feedback.

## Requirements and limits

The review uses the Git changes available in the thread environment. Review feedback is sent to the agent in the thread.

Review data, including unsent feedback, is automatically and irreversibly purged after seven days continuously archived or when its BB thread is deleted. Existing archives are included. Cleanup runs on load and hourly while enabled, in bounded batches; active reviews and comments already imported into other threads are retained.

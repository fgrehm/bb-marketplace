# Changelog

## [Unreleased]

- Automatically purge reviews after seven days continuously archived, including existing archives, and on thread deletion. Bounded startup and hourly sweeps reconcile missed events and missing threads; active reviews and independently imported feedback are retained.
- Resume existing reviews from the sidebar's Recent reviews page, with one latest snapshot per thread, pending human comments first, snapshot metadata, and viewed-file progress. Reloading the list does not refresh diffs or send feedback.
- Review uncommitted changes, a selected commit, or a committed branch comparison through immutable revisions, with previous revisions retained.
- Add feedback on diff lines or whole files, write a review note, and mark files as viewed. Refresh carries unresolved threads and the note forward.
- Compose file and line comments and reply to inline AI comments, including AI replies routed to their existing root thread, with focused editors and `Ctrl+Enter` submit. Failed saves keep the draft and show an inline error.
- Edit or delete your own comments until they are sent; AI-authored and sent comments are immutable, and a comment with replies cannot be deleted on its own. Your unsent comments and replies are badged as such and go to the agent in one batch, with no per-comment selection.
- Use the Review feedback drawer to manage comments and the review note, with All, Unviewed, and With open comments file filters and unresolved thread counts. Sending waits for the latest note to save; the send button and retry errors remain visible while comments scroll.
- Use agent tools to prepare reviews, inspect revision status, comment, resolve, find, and import review feedback.

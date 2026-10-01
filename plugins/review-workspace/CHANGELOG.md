# Changelog

## [Unreleased]

- **Review snapshots and comparisons.** Review uncommitted changes, a selected commit, a committed branch comparison, or everything against a merge-base branch. Revisions are immutable; previous revisions remain available, and empty uncommitted snapshots offer explicit target suggestions.
- **Diffs and navigation.** Keep raw changes as the review evidence, with generated lockfile/Rails-schema and over-256-KiB diffs loaded on demand. Capture bounded immutable raster image sides separately and preview them with file-level feedback. Vim-style navigation supports exact old/new multiline ranges without marking files viewed or sending feedback.
- **Tours and change coverage.** Add revision-scoped tours with clickable step navigation, validated multi-file anchors, related code-comment threads, explanatory cards, and raw changed-line coverage. Anchors do not carry forward to later revisions.
- **Viewed-file progress.** Track explicit per-file viewed baselines and report changed, unchanged, unknown, reverted, and baseline-provenance states. Opening or navigating a review does not advance a baseline.
- **Comments and feedback.** Add line/file comments, review notes, and replies to inline AI comments, including AI replies routed to their root thread. Edit or delete your own unsent comments, retain drafts after failed saves, and send pending comments and replies in one explicit batch. Refresh carries unresolved threads and the note forward.
- **Review management.** Resume reviews from the sidebar's Recent reviews page with one latest snapshot per thread, pending human comments first, snapshot metadata, and viewed-file progress. Purge reviews after seven days continuously archived and on thread deletion; bounded startup and hourly sweeps reconcile missed events and missing threads while retaining active reviews and independently imported feedback.
- **Mobile review.** Keep the diff prominent, with a compact inline Tour control and a bounded, independently scrollable tour panel. Keep file navigation and Viewed & next in one sticky row; put filters, scope, range/baseline options, keyboard help, and empty-file comments on demand. Preserve desktop layout and touch targets, and keep popovers within narrow viewports.
- **Agent tools.** Prepare reviews, inspect revision status, comment, resolve, find, and import review feedback.

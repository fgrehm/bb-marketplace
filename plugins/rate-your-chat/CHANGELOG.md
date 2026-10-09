# Changelog

## [Unreleased]

- Offer skippable whole-chat ratings only after archiving a visible chat, with no always-visible rating action.
- Rate usefulness from 1 to 5, select one or more purposes (coding, debugging, review, research, planning, writing, other), and add an optional note.
- Capture recorded model and reasoning variations, provider fallbacks, and partial-metadata warnings from local BB event history when saving.
- Keep one editable rating per chat in local SQLite, shared across clients, with stale-write protection and retained drafts after failed saves.
- Review, edit, delete, and export saved ratings as JSON from the sidebar, with no provider calls.

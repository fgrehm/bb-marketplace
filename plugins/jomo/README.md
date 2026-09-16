# jomo

jomo (lowercase) is a BB plugin for the joy of missing out. It holds the
firehose so you don't have to read it: a calm feed you skim, a library where
things rest unread and guilt-free ("for future research"), and a triage rhythm
that ends with a clean queue instead of an anxious badge count. This is still
a UI proof of concept with offline fake data, before any feed fetching,
extraction, or persistence lands.

The plugin owns a full-bleed nav-panel page with:

- A triage list over a multi-kind feed (articles, videos, posts, repos,
  releases, papers) with keyboard and swipe actions plus undo.
- Sweep mode: a one-card-at-a-time title-skimming sprint with an end summary,
  for emptying the queue in one sitting.
- A sources drawer: enable or pause sources (pausing hides their items),
  add feeds (they land paused), and paste-URL ad hoc capture into today's
  queue.
- A roundup card at the top of the feed: a render-only AI briefing seam — the
  plugin displays it when a backend thread provides one, and never lets AI
  surfaces mutate state on their own.
- A kind-aware reader routed through panel `subPath`, so browser back and
  forward work on the way in and out.
- Mobile and coarse-pointer support with gesture isolation throughout.

Install from this directory with `bb plugin install . --yes`. The feed is
intentionally fake and offline.

## What this proves

The current BB plugin surface can provide a substantially different body
layout, local navigation, and a reader transition without modifying BB core.

## Where it is going

The product thesis (see the repository's design scratch under
`.agents/scratchpad/jomo-rethink.md`): jomo is a hoard, not an inbox. Two
first-class kinds of keeping — "for now" (today's small skim) and "for future
research / KB" (the library, unbounded and guilt-free). The AI is a librarian
whose model of your interests is earned in a first-run interview plus analysis
of material you already have, then kept alive by everyday triage actions; the
roundup card grows into a JOMO report: proof that missing out was safe.

Likely next steps are large-volume ingest UX (300+ links per round), the
onboarding interview, and backend persistence. AI surfaces stay render-only
outcomes; the librarian never mutates state without an explicit rule the user
set.
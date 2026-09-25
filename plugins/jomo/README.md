# jomo

jomo (lowercase) is a BB plugin for the joy of missing out. It holds the
firehose so you don't have to read it: a calm feed you skim, a library where
things rest unread and guilt-free ("for future research"), and a review rhythm
that ends with a clean queue instead of an anxious badge count.

## Using jomo

### Install

```sh
bb plugin install path:/data/projects/bb-marketplace/plugins/jomo
```

Or from the public repo, selecting the plugin subdirectory:

```sh
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/jomo
```

jomo runs as full-trust code inside BB. It reads and writes your Obsidian
vault (the Library folder and `LINKS.md`), keeps its own SQLite database
under the plugin's data directory, and shells out to `gh` for GitHub links.

### The three loops

**Bring in links.** Paste URLs into `LINKS.md` under `## QUEUE` (or paste
them into the sources drawer). Tap "Bring in links" and jomo works the queue:
a progress bar, a per-item log, and a cancel button, and the run survives
reloads. Each page is fetched once and saved as Markdown. Successes leave the
queue and land in the Library; failures move to `## FAILED` with the real
reason. Paywalls that only serve share previews are kept as title-plus-summary
bookmarks rather than dropped.

**Review feeds.** Open "RSS review" and tap "Fetch feeds now" (nothing is ever
fetched on its own). New entries are staged in jomo's database as excerpts.
Then review them your way:

- *Salvage* (the source-scoped batch flow): choose a source filter, mark
  entries one by one with the star (save) or clock (queue) icons, then press
  Finish. One confirmation, then jomo processes the marks and discards the
  unmarked leftovers from that source only. Anything that fails stays staged.
- *Triage*: decide one entry at a time (keyboard: `j`/`k` move, `s` save,
  `l` queue, `x` discard, `o` open).
- *Sweep*: one card at a time for a focused sitting (space save, backspace
  discard, arrows skip).

Staged entries that you never touch drain after 30 days. Entries that were
already staged before this policy never drain.

**Review and keep.** RSS review is the active queue for deciding what to save,
queue, or discard. The Library lists everything you kept, newest first, and
opens saved articles in the reader.

### What goes over the network

Only when you ask: fetching feeds, pressing Save (one fetch per article), and
validating a feed URL when you add a source. Page fetches use a realistic
browser user agent, so some paywalled and bot-walled sites work. X/Twitter
posts are read through fxtwitter, GitHub links through the `gh` CLI. The
publish date shown is the article's own when the page declares one; otherwise
jomo shows when it added the item, never a guess.

### Settings

Configured on the plugin's settings page:

- `contentRoot` (default `/data/obsidian/Agent/Library`): where saved articles
  are written. Absolute path or `~/...`.
- `filenamePattern` (default `{{domain}}/{{date}}-{{slug}}.md`): file layout,
  with `{{date}}`, `{{site}}`, `{{slug}}`, and `{{idSuffix}}` tokens.
- `inboxLinksFile` (default `/data/obsidian/Inbox/LINKS.md`): the queue file.
- `pruneDrainedFiles` (default true): delete content files of drained
  entries.

### Terminal commands

```sh
bb jomo ingest-links --dry-run        # count the queue without touching it
bb jomo ingest-links --limit 20       # ingest at most 20 queued links
bb jomo reconcile-links --dry-run     # what is already archived but still queued
bb jomo import-library --dry-run      # preview importing existing vault notes
```

## How it works

The RSS review queue and Library read from SQLite. Links ingested on demand from
the Obsidian QUEUE go straight into the saved Library. RSS sources are
explicitly fetched into jomo's SQLite review queue; only an explicit Save
action fetches an article page and writes its content to the Library.

Content settings in the plugin settings page: `contentRoot` (defaults to `/data/obsidian/Agent/Library`, accepts another absolute path or `~/...`), `filenamePattern` (defaults to `{{domain}}/{{date}}-{{slug}}.md`, with GitHub, YouTube, and social paths matching the existing vault ingestion layout; supports `{{date}}`, `{{site}}`, `{{slug}}`, and optional `{{idSuffix}}` tokens), and `pruneDrainedFiles` (default true; staged feed entries have no content file to prune). These settings alone do not start ingestion. JOMO-owned content files are writable artifacts, not a backup of triage state.

On the JOMO home page, tap "Bring in links" to preview and confirm the whole queue. Ingestion runs in the background if you leave the page; reopening the panel shows persisted progress, completion, and recent failures. The equivalent terminal command `bb jomo ingest-links --dry-run` reads only `## QUEUE` in `/data/obsidian/Inbox/LINKS.md` (configurable via `inboxLinksFile`) and reports its deduplicated count. `bb jomo ingest-links --limit N` fetches at most N links (1–99), extracts Markdown using Defuddle or authenticated `gh` for GitHub repos/issues/PRs, writes new content files and DB entries, and returns per-link failures. Successful links are saved to the Library, removed from `## QUEUE`, and indexed under `Library/_index/<date>.md`. Failed attempts move to `## FAILED` with their error; unattempted links stay queued. If a vault update fails after the DB write, a subsequent `bb jomo reconcile-links --apply` or ingestion run retries reconciliation without refetching saved links. It never fetches `## FAILED` or polls feeds automatically. For RSS, tap "RSS review" and then "Fetch feeds now" to explicitly stage entries from enabled sources in SQLite. The RSS review screen is the single review hub: it lists staged entries in a triage list with keyboard actions (strictly one at a time; batching lives in Salvage), and offers two batch flows, Salvage (mark save/queue across the batch, then process the marks once and discard the unmarked leftovers) and a one-card-at-a-time sweep. Save to Library fetches the article page through the same extraction and persistence path as Links, Queue for later adds its URL to `LINKS.md`, and Discard marks it so it will not return. RSS staging does not rewrite `RSS.md`; feed excerpts are not saved as article content.

The plugin owns a full-bleed nav-panel page with:

- A first-run librarian interview: five skippable questions, a draft material-analysis pass, explicit profile review, and a persistent, editable Markdown notebook.
- A JOMO report that frames the roundup as proof that missing out was safe, not another list of arrivals.
- A heuristic Librarian Desk for link queueing, staged feed subscriptions, and citations from loaded real items. Confirmed mutations persist; AI prose remains heuristic, not provider-backed.
- A Library tab backed by saved SQLite metadata (including ingested QUEUE links), paginated 50 at a time, rendering vault Markdown and sanitized HTML on open. Imported files remain read-only references. Use `bb jomo import-library --dry-run` to inspect the configured content root, then `bb jomo import-library --apply` to insert metadata and file pointers without modifying existing Markdown. Repeated imports skip existing IDs.
- An RSS review hub with SQLite staging, explicit refresh, a phone-sized triage list, source filtering, source-scoped Salvage (mark entries individually, then process that source's batch once and discard its unmarked leftovers), a one-card-at-a-time sweep, drain status, and source add/pause controls. Approved saves share the same article extraction and content-store path as Links. Legacy triage, sweep, and reservoir deep links redirect here.
- A sources drawer backed by SQLite: enable or pause feeds, add feeds paused (adding probes the feed once to validate it, resolving YouTube channels to their `channel_id` feed), and queue pasted URLs into `LINKS.md` without fetching. Feed `<category>` terms become staged item tags.
- A roundup card at the top of the feed: a render-only AI briefing seam — the
  plugin displays it when a backend thread provides one, and never lets AI
  surfaces mutate state on their own.
- A kind-aware reader routed through panel `subPath` for RSS items and library articles alike, so browser back and forward work on the way in and out.
- Mobile and coarse-pointer support with gesture isolation throughout.

Feeds are fetched only after an explicit user action. Existing staged entries have no drain date; new ones drain after 30 days from staging if still unreviewed.

## UI layout

`app.tsx` wires the JOMO page and navigation. `components/` holds the reader, triage, salvage, sweep, sources drawer, and RSS review. `item-projection.ts` maps SQLite metadata to the shared item shape used by the reader and review surfaces; `rss-item.ts` uses that projection for staged review rows. Only the Librarian Desk's conversation heuristics and onboarding's material analysis are mock AI. No automatic feed fetching is enabled.

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

The backend persists RSS sources, seen identities, staged entries, and refresh progress in SQLite; approved article saves share the Links extraction and content-store path. AI surfaces stay render-only outcomes; the librarian never mutates state without an explicit rule the user set.
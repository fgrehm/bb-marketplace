# bb-marketplace

A collection of [BB](https://github.com/get-bb/bb) plugins I maintain, installable
from bb's plugin marketplaces as a third-party catalog.

## Install

> **Pre-release:** No versioned releases or npm packages have been published yet. The marketplace catalog is present for future releases, but plugins should currently be installed directly from the repository for testing.

Install a plugin from the latest `main` branch:

```sh
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/flux
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/pi-extras
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/pi-settings
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/favicon
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/review-workspace
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/bulk-archive
```

These are full-trust, pre-release plugins. Review the source before installing. BB records the Git source and plugin subdirectory so updates and removal continue to work normally.

For local development, clone the repository and install a plugin by path:

```sh
bb plugin install path:/path/to/bb-marketplace/plugins/<id>
```

Once versioned releases exist, the marketplace can be added with:

```sh
bb marketplace add https://raw.githubusercontent.com/fgrehm/bb-marketplace/main/marketplace.json
```

## Plugins

### [Flux](plugins/flux) - `flux`

A proof-of-concept feed aggregator and reading room with fake data. It tests a calmer, alternative UX while keeping a visible path back to normal BB navigation, which is important for mobile.

### [Pi Usage](plugins/pi-extras) - `pi-extras`

### [Pi Settings](plugins/pi-settings) - `pi-settings`

Pi-focused usage extras in a single sidebar panel with two tabs:

- **Sessions** - estimated token usage and cost computed from local Pi session
  transcripts, broken down by the backend each session used (Codex, OpenCode
  Go, Ollama Cloud), with per-provider marks. Backed by a durable parse cache
  and a `bb usage show` CLI. Adapted from
  [iamEvanYT/bb-usage-page](https://github.com/iamEvanYT/bb-usage-page),
  scoped to Pi.
- **Subscriptions** - live subscription usage for Pi-managed Codex, OpenCode
  Go, and Ollama Cloud credentials (read from Pi's `auth.json`, never logged
  or displayed), with a short TTL cache for snappy tab switches.

### [Favicon](plugins/favicon) - `favicon`

Replaces the browser tab favicon with uploaded light/dark SVG artwork. Reacts
to bb's theme changes; artwork is managed from the plugin's settings section.

### [Review Workspace](plugins/review-workspace) - `review-workspace`

Diff-first asynchronous review workspaces inside a thread: snapshots the
environment's uncommitted changes as immutable revisions, lets a reviewer
select exact line ranges in the diff and anchor comments, carry comments
forward to refreshed revisions, and send a batch of feedback to the agent in
the parent thread.

### [Bulk Archive](plugins/bulk-archive) - `bulk-archive`

A mobile-first settings panel for selecting and archiving multiple inactive
threads at once - filter by project, title, and inactivity period; archiving a
parent also archives its children.

## Repo layout

Each plugin is self-contained under `plugins/<id>/` with its own
`package.json` and lockfile (pnpm). [`marketplace.json`](marketplace.json) at
the root is the catalog bb reads. Future plugin releases will be resolved from git tags like `favicon/0.1.0` (subdirectory and tag prefix per plugin).

## Development

```sh
cd plugins/<id>
pnpm install
pnpm run typecheck   # or pnpm run lint on some plugins
pnpm test            # where tests exist
bb plugin install . --yes   # install into a running bb from the source dir
bb plugin reload <id>       # rebuild + reload after edits
```

Install the repository's [prek](https://prek.ag) hooks before committing:

```sh
prek install
prek run --all-files
```

Pre-commit hooks validate JSON, run plugin typechecks, and check Review Workspace formatting. The heavier plugin test suites run before pushes. GitHub Actions runs the full plugin matrix on pushes and pull requests. Hooks are grouped by plugin and concern, for example `prek run --group flux` or `prek run --group format`.

Requirements: node ≥ 22, pnpm, and a bb ≥ 0.42 install.

Licensed under MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

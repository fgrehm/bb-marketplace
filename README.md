# bb-marketplace

A collection of [BB](https://github.com/get-bb/bb) plugins I maintain, installable from bb's plugin marketplaces as a third-party catalog.

## Install

> **Pre-release:** No versioned releases or npm packages have been published yet. The marketplace catalog is present for future releases, but plugins should currently be installed directly from the repository for testing.

Install a plugin from the latest `main` branch:

```sh
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/pi-extras
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/favicon
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/review-workspace
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

The catalog uses marketplace schema v2, so BB versions that only support v1 catalogs cannot read it.

## Plugins

### [Pi Extras](plugins/pi-extras) - `pi-extras`

Pi-focused usage extras in a single sidebar panel with two tabs:

- **Sessions** - estimated token usage and cost computed from local Pi session transcripts, broken down by the backend each session used (Codex, OpenCode Go, Ollama Cloud), with per-provider marks. Backed by a durable parse cache. Adapted from [iamEvanYT/bb-usage-page](https://github.com/iamEvanYT/bb-usage-page), scoped to Pi.
- **Subscriptions** - live subscription usage for Pi-managed Codex, OpenCode Go, and Ollama Cloud credentials (read from Pi's `auth.json`, never logged or displayed), with a short TTL cache for snappy tab switches.
- **Thread titles and commit messages** - registers Pi as a BB AI service for both tasks. Select Pi independently for each under Settings → AI services, with separate model choices in the settings panel.

### [Favicon](plugins/favicon) - `favicon`

Replaces the browser tab favicon with uploaded light/dark SVG artwork. Reacts to bb's theme changes; artwork is managed from the plugin's settings section.

### [Review Workspace](plugins/review-workspace) - `review-workspace`

Diff-first asynchronous review workspaces inside a thread: snapshots uncommitted changes, individual commits, or committed branch diffs as immutable revisions, lets a reviewer select exact line ranges in the diff and anchor comments, carry unresolved comment threads forward to refreshed revisions, and send a batch of feedback to the agent in that same BB thread. The sidebar's Recent reviews page resumes each thread's latest saved review, with pending-comment counts and viewed-file progress.

### [Rate Your Chat](plugins/rate-your-chat) - `rate-your-chat`

Skippable whole-chat feedback offered after archiving. Stores usefulness, use case, notes, and recorded model/reasoning variations in local SQLite, with editing and JSON export. No feedback is sent to providers. This experiment is not in the marketplace catalog; install from a local checkout to try it.

## Repo layout

Each plugin is self-contained under `plugins/<id>/` with its own `package.json` and lockfile (pnpm). [`marketplace.json`](marketplace.json) at the root is the v2 catalog BB reads; its `overview` fields contain Markdown long-form descriptions. Plugin releases are resolved from git tags like `favicon/v0.1.0` (plugin-specific prefix per catalog entry).

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

Pre-commit hooks validate JSON, run plugin typechecks, and check Review Workspace formatting. The heavier plugin test suites run before pushes. GitHub Actions runs the full plugin matrix on pushes and pull requests. Hooks are grouped by plugin and concern, for example `prek run --group pi-extras` or `prek run --group format`.

Requirements: node ≥ 22, pnpm, and a bb ≥ 0.42 install.

Licensed under MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

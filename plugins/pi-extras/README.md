# Pi Usage

A local BB plugin that bundles Pi usage views into a single sidebar panel and adds global Pi configuration under BB Settings.

- **Sessions** - estimated token usage and cost computed from local Pi
  sessions (`~/.pi/agent/sessions` and `~/.bb/pi-bridge-sessions`), adapted
  from [iamEvanYT/bb-usage-page](https://github.com/iamEvanYT/bb-usage-page)
  (MIT), vendored under `usage-page/` and scoped to Pi only.
- **Subscriptions** - subscription usage for Pi-managed Codex, OpenCode Go,
  and Ollama Cloud credentials.

The plugin adds **Pi Usage** to BB's main sidebar and **Pi** to BB Settings. It is not an agent provider and does not appear in the provider or model pickers. See `THIRD_PARTY_NOTICES.md` at the repository root for full attribution.

## Screenshots

### Sessions

![Pi Usage sessions](docs/sessions.webp)

### Subscriptions

![Pi Usage subscriptions](docs/subscriptions.webp)

### Settings

![Pi settings](docs/settings.webp)

## Subscriptions tab

The host worker reads Pi's `auth.json` from `$PI_CODING_AGENT_DIR/auth.json`,
or `~/.pi/agent/auth.json` when that variable is unset. It reads credentials
only and never logs, displays, refreshes, or modifies them.

Missing credentials are shown as "not configured", so the plugin remains
usable when only some providers are set up. An unreadable or malformed auth
file is reported as an error. Codex authentication failures are shown as
expired and should be refreshed through Pi.

The Codex and Ollama usage endpoints are undocumented and may change.

## Settings

The Settings entry manages global Pi defaults for provider, model, thinking level, and enabled model patterns. It can also refresh model catalogs and update Pi extensions, with command output shown in the UI. The plugin preserves unrelated Pi settings and never reads or changes credentials.

## Development

```sh
pnpm install
pnpm test
pnpm run lint
bb plugin install . --yes
```

Tests use fake file reads and fake HTTP responses. They make no network calls
and never read your Pi credentials.

# Pi Settings

A BB plugin that exposes selected global Pi settings under BB Settings instead of the main sidebar.

It supports:

- Default provider and model.
- Default thinking level.
- Enabled model patterns.
- Refreshing Pi model catalogs.
- Updating Pi extensions.

The plugin only reads and writes the global `$PI_CODING_AGENT_DIR/settings.json` file. Credentials, project settings, and arbitrary Pi files are not exposed.

## Development

```sh
pnpm install
pnpm run lint
bb plugin build
```

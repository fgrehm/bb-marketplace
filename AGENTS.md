# Agent instructions

## Repository

This repository contains independently installable BB plugins under `plugins/<id>/`. The root `marketplace.json` is the catalog; each plugin's `package.json` is its manifest and source of truth for its plugin ID, version, BB entry points, and engine requirements.

The repository is MIT licensed. Preserve `THIRD_PARTY_NOTICES.md` and vendored license files when adapting code or artwork.

## Before changing a plugin

- Read the plugin's README and `package.json` first.
- Keep the plugin ID, package name, marketplace entry, README, and manifest description aligned.
- Treat plugin code as full-trust code running inside BB. Review source and avoid unnecessary access to credentials or host data.
- Keep each plugin self-contained. Do not import source files from sibling plugins.
- Keep runtime dependencies in `dependencies`; keep SDK types and build/test tools in `devDependencies`.
- Do not edit generated `dist/` files manually. Rebuild them with `bb plugin build` when needed.

## Development

Use pnpm from the plugin directory:

```sh
cd plugins/<id>
pnpm install
pnpm run typecheck   # or pnpm run lint where defined
pnpm test            # where defined
bb plugin build
```

With BB running, use live development to rebuild and reload a plugin after every source change:

```sh
cd plugins/<id>
bb plugin dev
```

Press Ctrl+C to stop. The development build is unminified for readable stack traces.

Install the repository's prek hooks once per checkout:

```sh
prek install
```

After that, `git commit` runs the pre-commit checks automatically, including the Review Workspace formatting check. `git push` runs the heavier pre-push test suites. GitHub Actions runs the full plugin matrix on pushes and pull requests. Format files explicitly with the plugin's documented formatter command before committing. Use `prek run --all-files` only when you intentionally want to check the entire repository outside a commit. Plugin-specific groups are available with commands such as `prek run --group flux` and `prek run --group format`.

## Source installation

Plugins are pre-release and are not currently published to npm. Install one directly from a local checkout:

```sh
bb plugin install path:/path/to/bb-marketplace/plugins/<id>
```

Or install from the public Git repository and select a plugin subdirectory:

```sh
bb plugin install git:github.com/fgrehm/bb-marketplace@main --subdirectory plugins/<id>
```

BB plugins are full-trust code. Review a plugin's source before installing it.

## Marketplace changes

When adding or removing a plugin, update both `marketplace.json` and the root README. Marketplace releases will use plugin-specific tags such as `<id>/0.1.0`; no versioned releases have been cut yet.

## Completion checklist

- Run the affected plugin's typecheck and tests.
- Run `bb plugin build` for changes to plugin manifests or build surfaces.
- Run `prek run --all-files`.
- Use a focused Conventional Commit message, unless the task explicitly calls for history rewriting.

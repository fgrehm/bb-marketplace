# Agent instructions

## Repository

This repository contains independently installable BB plugins under `plugins/<id>/`. The root `marketplace.json` is the published v2 catalog. Each catalogued plugin's `PLUGIN_OVERVIEW.md` is the source of truth for its store overview, inlined into the catalog by `scripts/sync-marketplace-overviews.mjs`; other catalog fields remain hand-authored. Each plugin's `package.json` is its manifest and source of truth for its plugin ID, version, BB entry points, and engine requirements.

The repository is MIT licensed and maintained as personal software, shared in case it is useful to others. Preserve the maintainer's needs and explicit direction over generic product conventions. Discussions are open for questions, ideas, and feedback; issues and pull requests are reserved for the maintainer's tracking and development workflow. Do not assume broader community contributions or support are part of the project. Preserve `THIRD_PARTY_NOTICES.md` and vendored license files when adapting code or artwork.

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

After that, `git commit` runs the pre-commit checks automatically, including the Review Workspace formatting check. `git push` runs the heavier pre-push test suites. GitHub Actions runs the full plugin matrix on pushes and pull requests. Format files explicitly with the plugin's documented formatter command before committing. Use `prek run --all-files` only when you intentionally want to check the entire repository outside a commit. Plugin-specific groups are available with commands such as `prek run --group jomo` and `prek run --group format`.

## Source installation

Plugins are pre-release and are not currently published to npm. Install one directly from a local checkout:

```sh
bb plugin install path:/path/to/bb-plugins/plugins/<id>
```

Or install from the public Git repository and select a plugin subdirectory:

```sh
bb plugin install git:github.com/fgrehm/bb-plugins@main --subdirectory plugins/<id>
```

BB plugins are full-trust code. Review a plugin's source before installing it.

## Marketplace entries

When adding or removing a plugin, update both `marketplace.json` and the root README. The v2 catalog is strict: keep each `id`, display name, short description, icon, author, and Git source accurate and aligned with the plugin manifest. Keep short descriptions concise (about 140 characters or fewer) and use up to ten lowercase, hyphenated tags.

Author store copy in `plugins/<id>/PLUGIN_OVERVIEW.md`, not directly in the catalog's generated `overview` field. Run `node scripts/sync-marketplace-overviews.mjs` after editing; CI and prek reject stale output with `--check`. The script only reads catalogued plugins and updates overview values, preserving other metadata. See the root README's Marketplace copy section for the check and test commands. The overview is not a README substitute: lead with the user outcome, then summarize key features, requirements, privacy, and meaningful limitations. Keep it under 4000 characters; use supported Markdown only, with no raw HTML, tables, or embedded images. Screenshots belong in the separate optional `screenshots` field, not the overview. The Community marketplace guidance recommends up to six PNG, JPEG, or WebP screenshots, each at least 1200 pixels wide and no larger than 2 MiB. See [overview guidance](https://github.com/get-bb/marketplace#long-form-description) and [screenshot guidance](https://github.com/get-bb/marketplace#screenshots-and-icons).

This catalog uses Git SemVer ranges with plugin-specific tags. For each entry, `source.git.url` points to this repository, `subdir` is `plugins/<id>`, and `tagPrefix` is `<id>/`. Keep the range compatible with intended releases; for example, `^0.1.0` admits `0.1.x` tags, not `0.2.0`.

## Releasing a catalogued plugin

Plugins are versioned independently in this monorepo and are not published to npm. For the first release use `0.1.0`; later releases update only the selected plugin's `package.json` version and `CHANGELOG.md`. Keep pending changes under `## [Unreleased]`; when preparing a release, move those notes into a `## [<version>] - YYYY-MM-DD` section. Keep the marketplace short description and overview aligned with actual behavior, and widen the catalog range only when the release policy should admit a new version line.

Before tagging, commit and push the reviewed release changes to `main`, run the plugin's typecheck, tests, formatter, and `bb plugin build`, then run `prek run --all-files` and `git diff --check`. Create an annotated signed tag for the exact release commit, verify it locally, and push the tag only after explicit approval:

```sh
git tag -s favicon/v0.1.0 -m "favicon v0.1.0"
git verify-tag favicon/v0.1.0
git push origin favicon/v0.1.0
```

Use the corresponding plugin ID and version in the tag and message. The signing key must be registered with GitHub so the signature is verifiable there; see [GitHub's tag-signing guide](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-tags). The release workflow reruns the full CI matrix, requires GitHub to verify the annotated tag signature, extracts that version's section from `plugins/<id>/CHANGELOG.md` as the GitHub Release notes, and creates a release without assets. BB installs and updates from the Git tag selected by the marketplace range; it does not consume the GitHub Release page.

## New-plugin checklist

When adding a plugin, complete every item below before considering the work done:

1. Create a self-contained `plugins/<id>/` directory with a manifest, README, source entry points, lockfile, and appropriate tests.
2. Keep the plugin ID, package name, manifest display name/description, plugin README, marketplace entry, and root README entry aligned. For catalogued plugins, add `PLUGIN_OVERVIEW.md` and sync its overview as described above.
3. Add the plugin to `.pre-commit-config.yaml` with typecheck and test hooks where applicable.
4. Add the plugin to `.github/workflows/ci.yml` so CI installs its lockfile and runs its checks.
5. Run the plugin's typecheck, tests, formatter, and `bb plugin build`; do not edit generated `dist/` files manually.
6. Run `prek run --all-files` and inspect `git diff --check`.
7. Install or reload the plugin locally and verify its registered surfaces, name, icon, and disabled/error behavior.
8. Document installation, permissions, configuration, and screenshots or usage examples when the plugin has a user-facing UI.

## Completion checklist

- Run the affected plugin's typecheck and tests.
- Run `bb plugin build` for changes to plugin manifests or build surfaces.
- Run `prek run --all-files`.
- Use a focused Conventional Commit message, unless the task explicitly calls for history rewriting.

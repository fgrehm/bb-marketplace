# Favicon

A BB plugin that replaces the browser tab favicon with uploaded light/dark SVG artwork.

Upload separate SVGs for light and dark mode from the plugin's settings section; bb's favicon color tint is applied on top and the unread-badge dot is preserved. SVG-only keeps the artwork crisp at the 16px and 32px favicon sizes.

Install from this repository with:

```sh
bb plugin install path:/path/to/bb-marketplace/plugins/favicon
```

Then upload separate light and dark SVG files in the plugin settings and reload the plugin. URLs and file paths are not supported.

This is window-wide, not project-specific: BB's current plugin API does not expose a project-scoped favicon hook. The plugin uses a content script and restores the previous favicon when disabled or reloaded.

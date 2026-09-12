# Flux

Flux is a proof-of-concept BB plugin for a feed aggregator and web-clipping experience. It uses fake stories to test a different information architecture before adding feed fetching, article extraction, or persistence. It now also exercises BB's experimental app-overlay surface to cover the host shell with a sidebar-free mode.

The plugin owns a full-bleed nav-panel page with:

- A calm, card-based feed with source, topic, and reading-time metadata.
- For you, Saved, AI & tools, and Design filters.
- A focused article reader state with a clear return path.
- A visible "Back to BB" action that returns to the normal compose surface, which is important for mobile and for escaping the alternative UX.

Install from this directory with `bb plugin install . --yes`. When enabled, Flux opens as a sidebar-free overlay; use **Back to BB** to return to normal navigation. The feed is intentionally fake and offline.

## What this proves

The current BB plugin surface can provide a substantially different body layout, local navigation, and a reader transition without modifying BB core. The experimental app-overlay surface can cover the host shell and provide a true sidebar-free mode for a focused plugin experience. The overlay is deliberately dismissible through "Back to BB"; this is the escape hatch mobile needs.

Likely next steps are RSS/Atom ingestion on the server, sanitized article extraction, saved-item storage, and an action that turns a story into a BB thread. Keep the escape hatch when those are added.

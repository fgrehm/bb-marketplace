Flux explores a reading-first way to use BB. It gathers ideas into a calm feed, makes saved items easy to revisit, and opens stories in a focused reader instead of another dense workspace panel.

This release is a UI proof of concept with offline fake data. It intentionally focuses on the shape of the experience:

- Browse a personalized feed of short story cards.
- Filter by saved items, AI and tools, or design.
- Open a story into a distraction-free reader.
- Return to the normal BB compose surface at any time.
- Run as a sidebar-free app overlay that covers the host shell.

The last two items are part of the experiment, not an afterthought. Alternative plugin-owned navigation should be additive and reversible, especially on mobile where the normal app shell remains the safest way home.

Once the interaction feels right, the server can grow to fetch RSS and Atom sources, extract article content, sanitize HTML, and persist saved items. A later iteration could connect a story to a BB thread, for example by creating a discussion prompt with the article URL and notes.

Flux uses BB's experimental app-overlay surface to cover the host shell without modifying BB core. The overlay is full-screen and dismissible, with an explicit escape back to the normal compose surface. This is promising for mobile, but the current PoC starts the overlay whenever the plugin is loaded and uses local visibility state; production use needs host lifecycle and activation semantics so it can be reopened predictably.

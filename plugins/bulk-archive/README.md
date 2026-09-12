# bb-plugin-bulk-archive

A mobile-first BB navigation panel for selecting and archiving multiple inactive threads.

It lists thread title, last activity, age, runtime status, and environment. Filter by project, title, and inactivity period, then confirm the batch archive. Archiving a selected parent also archives its child threads.

## Development

```sh
pnpm run typecheck
bb plugin build
bb plugin install .
bb plugin reload bulk-archive
```

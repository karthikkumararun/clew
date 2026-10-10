## Context

Canvas: `design/canvas/CommandPalette.dc.html`. The shell already has a command registry; introspection from the driver framework feeds the index.

## Decisions

- **Index in SQLite + matcher in Rust.** `palette_index(connection_id, path, kind, name, parent_label, updated_at)`. Search loads candidate names into an in-memory `nucleo-matcher` pool per connection (rebuilt on index change) and scores in Rust; the UI receives the top 50 with match indices for highlighting. Actions and recent queries are scored in the frontend with the same algorithm (`fzf`-style port) because they live in JS.
- **Indexing cost:** columns are indexed only from the completion snapshot (already fetched for completion), so no extra queries run.
- **Rendering:** a listbox with `aria-activedescendant`; virtualized when > 100 rows.

## Risks / Trade-offs

- [Stale index for objects created elsewhere] → Index age shown in the footer tooltip; "Refresh index" action.

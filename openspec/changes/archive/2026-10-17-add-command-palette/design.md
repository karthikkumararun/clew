## Context

Canvas: `design/canvas/CommandPalette.dc.html`. The shell already has a command registry; introspection from the driver framework feeds the index.

## Decisions

- **Index in SQLite + matcher in Rust.** `palette_index(connection_id, path, kind, name, parent_label, updated_at)`. Search loads candidate names into an in-memory `nucleo-matcher` pool per connection (rebuilt on index change) and scores in Rust; the UI receives the top 50 with match indices for highlighting. Actions and recent queries are scored in the frontend with the same algorithm (`fzf`-style port) because they live in JS.
- **Indexing cost:** columns are indexed only from the completion snapshot (already fetched for completion), so no extra queries run.
- **Rendering:** a listbox with `aria-activedescendant`; virtualized when > 100 rows.

## Risks / Trade-offs

- [Stale index for objects created elsewhere] → Index age shown in the footer tooltip; "Refresh index" action.

## Implementation notes

Decisions taken while building, where the first draft was silent or needed to change:

- **What feeds the index.** `completion_snapshot` is the only introspection that already walks a whole database, so the Tauri command folds each snapshot it returns into the index (`src-tauri/src/commands/palette.rs`). Nothing else runs queries. The frontend fetches a snapshot as soon as a connection connects (`src/features/palette/indexing.ts`), so objects are searchable without a console being open, and "Refresh object index" invalidates and refetches. The snapshot of a connection's configured (or default) database is indexed; other databases of a server are indexed once a console or the explorer asks for them.
- **Memory first, SQLite behind it.** `Palette` keeps every entry in memory and `nucleo-matcher` scores that vector; `palette_index` in `clew.db` is only written (in the background) and read back at start-up, so disconnected connections stay searchable after a restart. Deleting a connection removes its entries.
- **Ranking.** nucleo's score, plus a large bonus for an exact prefix and a smaller one for a word start (after `_ . - / :` or a space), then object kind (tables before columns), then how recently the entry was indexed, then the shorter name. The same rules are ported in `src/features/palette/fuzzy.ts` for queries and actions. The empty query lists the newest tables.
- **Alt+Enter text.** The starter query is `SELECT * FROM "public"."orders" LIMIT 100;`, the same text as the explorer's "Open table in console", qualified by schema (or by database on MySQL-like servers). The scenario's `analytics.public.orders` is illustrative: PostgreSQL rejects a database-qualified name, and the console is opened on that database and schema already.
- **Columns and fields** are indexed as `table.column` and open their table (a column through "filter by column"). Graph labels and relationship types come from `SchemaSnapshot.graph` and open a graph console with the query already run (Alt+Enter: the query, not run).
- **Actions.** Every registered command is listed except those that need an argument another feature supplies (`NEEDS_ARGUMENT` in `actions.ts`) and the palette's own. Selection-aware entries ("Generate DDL for orders", "Count rows in orders", "New console on prod-postgres") follow the explorer selection and run the explorer commands against it. There is no "Export orders to CSV…" yet because exporting a table is only reachable from an open table tab; it joins the context entries when a table export command exists.
- **Queries section.** Recent statements come from the history table across connections (`palette_recent_queries`), saved queries are the files of each connection's Scripts folder, and recent files are remembered when a console is bound to a file (`recentFiles.ts`, kept in UI state). Matching is on the statement text or the file name; matching inside file contents ("matches “orders” on line 4") is not done.
- **Not in this change.** Redis key prefixes (Redis has no completion snapshot, so they need their own indexing hook), and virtualization: sections are capped (8, 5 and 6 rows on All; 50 on a single scope), so the list never exceeds about 160 rows.

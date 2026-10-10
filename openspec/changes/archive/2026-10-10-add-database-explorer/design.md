## Context

The driver framework exposes `introspect_children(connection_id, path)`. This change builds the tree UI. Canvas: `design/canvas/Main.dc.html` (EXPLORER aside: 24px rows, 18px indent per level, uppercase group headers, badges, env dots, right-aligned dim detail, selected row `--bg-selected` with `inset 2px 0 0 var(--accent)`).

## Goals / Non-Goals

**Goals:** fast with thousands of tables; keyboard-first; no blocking of other work.
**Non-Goals:** cross-connection search (that's the command palette); editing schema objects (ALTER TABLE UI) in v1.

## Decisions

- **Flattened, virtualized tree.** Keep a normalized node map (`id → {node, childrenIds, state: idle|loading|loaded|error}`) and derive a flat list of visible rows; render with `@tanstack/react-virtual`. Expansion is O(visible).
- **Node ids** are stable paths: `<connId>/db:analytics/schema:public/group:tables/table:orders/col:id`. Persisted expansion state stores these ids in `ui_state` under `explorer.expanded`.
- **Request coalescing:** one in-flight request per node; Refresh cancels and replaces.
- **Row-count estimates** come from introspection; Count rows calls a driver `count_rows` (exact `SELECT count(*)`) on the metadata pool.
- **DDL generation** is driver-specific: PostgreSQL builds it from the catalogue (no `pg_dump` dependency); SQLite reads `sqlite_master.sql`.
- **Context menu** uses the shared `Menu` primitive; actions are registered in the command registry so the palette can reuse them.

## Risks / Trade-offs

- [Huge schemas (10k+ tables)] → virtualization plus a cap of 5,000 children rendered per group with a "Show all / filter" hint.
- [Estimates are stale] → label them as estimates in the tooltip ("≈12,480 rows · from statistics").

### Decisions made during implementation
- **DDL command:** `introspect_ddl` already existed from `add-driver-framework` (SQLite and MySQL implemented), so Generate DDL uses it and PostgreSQL gained its implementation (`drivers/postgres/ddl.rs`) instead of a new `explorer_ddl` command. A SQLite table's DDL now also lists its indexes and triggers.
- **Count rows:** new `Driver::count_rows` (PostgreSQL, MySQL/MariaDB, SQLite) behind the `explorer_count_rows` command; the exact count is kept in the explorer store and shown in place of the estimate.
- **Contracts with later changes:** the explorer runs `console.new` (`{ connectionId, database?, schema?, sql? }`), `table.open` (`{ connectionId, path }`) and `table.filterByColumn` (`{ connectionId, path, column }`) through the command registry. Until those exist the menu says the action isn't available yet; Generate DDL falls back to copying the statement. A table editor tab (`kind: "table"`) must carry `{ connectionId, path }` in its state so the explorer can reveal it.
- **Connection list:** the explorer replaces `ConnectionList` (group headers, connection rows and drag-to-move are rows of the same virtualized tree); connection actions moved into the row context menu and the `connection.*` commands.
- **Empty state text:** "No connections yet." keeps its full stop so it doesn't collide with the Welcome screen's identical heading in text queries.
- **Estimates and counts:** both use the drivers' `12.4k` format; a tooltip says whether the figure is an estimate ("from statistics") or exact.
- **Scripts node:** a client-side node (`scripts`, with `script` children) appended after the databases of every SQL connection. It lists the `.sql` files of the connection's Scripts folder through `connections_scripts_list` (no content is read until a file is opened), `connections_scripts_new` creates an empty file with a numeric suffix instead of overwriting, and `connections_scripts_reveal` opens Finder / Explorer on the folder or one file (paths that escape the folder are refused). Opening a script runs `script.open` (`{ connectionId, path }`), implemented by `add-sql-console`.

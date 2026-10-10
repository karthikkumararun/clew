## Context

Console results (from `add-sql-console`) and tables both need a grid. Canvas: `design/canvas/DataGrid.dc.html` (its script shows the exact pending-state colors per row kind) and the result grid in `design/canvas/Main.dc.html`.

## Goals / Non-Goals

**Goals:** smooth with very large results; safe editing where nothing touches the database until Submit; one grid component for every place data shows.
**Non-Goals:** spreadsheet formulas, pivoting, charts, editing multi-table join results (v1 edits single-table results only).

## Decisions

### Glide Data Grid
`@glideapps/glide-data-grid` renders to canvas, virtualizes rows and columns, and has built-in range selection, copy, column resize/move and custom cell renderers. Alternatives: TanStack Table + DOM virtualization (more control but much more work for selection/copy/editing and slower at 1M rows); AG Grid (enterprise features gated behind a commercial license). Theme maps to tokens via a `Theme` object built at runtime from `getComputedStyle(document.documentElement)`; custom `drawCell` paints NULL italics, FK underline and the edited-cell ring.

### Data in memory
Rows live in a `ResultStore` (columnar arrays per batch) so `getCellContent(col,row)` is O(1). Console results append pages; the table editor replaces pages.

### Editing model
`ChangeSet { edits: Map<RowKey, Map<Col, {old, new}>>, inserts: Row[], deletes: Set<RowKey> }`, where `RowKey` is the primary-key tuple (or unique key). The UI derives cell/row states from it. Undo/redo is a stack of ChangeSet operations.

### SQL generation in Rust
`changes_preview(conn, table, changeset)` → statements; `changes_apply` runs them in one transaction on the tab's session:
- UPDATE `… SET col = $1 WHERE pk = $2 AND col = $old` (optimistic check only on edited columns; `IS NOT DISTINCT FROM` for NULL-safe comparisons); expect exactly 1 row affected.
- INSERT with only the columns the user set (others get DEFAULT); `RETURNING *` where supported to reload.
- DELETE by primary key.
Values are always bound parameters, never interpolated. Identifier quoting is per-dialect (`"x"`, `` `x` ``, `[x]`).

### Table queries
`table_query(conn, table, where, order_by, offset, limit)` builds `SELECT * FROM <qualified> [WHERE (<where>)] [ORDER BY <order_by>] LIMIT/OFFSET` (dialect-specific paging for SQL Server). The WHERE/ORDER BY fragments are raw SQL by design (power-user feature, same as DataGrip) and are executed with the session's read-only state honored by `add-production-safeguards`.

### Export
Rust `export_result(source, format, options, path)` re-runs the query with a streaming cursor and writes through a buffered writer; progress events on a channel; cancel deletes the partial file.

## Risks / Trade-offs

- [Raw WHERE fragments allow arbitrary SQL] → They run on the user's own session with their own privileges; read-only sessions stay read-only. This is the intended power-user behaviour.
- [Glide's canvas text differs slightly between WebKit and WebView2] → Use the bundled fonts and verify headers on both CI OSes.
- [Optimistic check on float columns] → Compare floats by their textual representation from the driver; document that edits to float columns may report a conflict after rounding.

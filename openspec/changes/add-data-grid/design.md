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

## Decisions made during implementation

- **Table metadata.** One driver method, `table_meta`, feeds the Structure / Indexes / Relations views, the row key (primary key, else the first unique index whose columns are all NOT NULL), the "≈ rows" estimate and the record panel's REFERENCED BY list.
- **Counts.** The first page never waits for `count(*)`. Small tables get the exact count after the page; tables estimated above 1,000,000 rows show "≈ n" (unfiltered) or only a "Count exactly" link (filtered).
- **Sorting.** Header clicks in the table editor write `ORDER BY` (the database sorts, not the client). The console sorts loaded rows and offers a "Re-run with ORDER BY" that wraps the statement as a subquery.
- **Edits are bound parameters.** `Session::execute_params` was added for UPDATE / INSERT / DELETE. PostgreSQL sends every value as text with an explicit `$n::type` cast (so enums, numeric, jsonb, timestamptz need no per-type binding); MySQL and SQLite bind typed values. Parameterless transaction statements go over MySQL's text protocol because `START TRANSACTION` / `SAVEPOINT` are not allowed in its prepared protocol.
- **Optimistic check.** Every edited column is compared in the UPDATE's WHERE (`IS NOT DISTINCT FROM` / `<=>` / `IS`; `IS NULL` for a NULL original). An UPDATE or DELETE that matches no row stops the batch as a conflict. The check is on edited columns only, as designed.
- **Transaction.** Edits run as BEGIN … COMMIT on the tab's session; if the user already has a manual transaction open they run inside a savepoint, so a failed batch is undone without ending the user's transaction.
- **No `RETURNING` reload.** After a successful submit the page is read again instead (works on every driver and also picks up trigger / default changes).
- **Failure reporting.** Statement failures come back as data (`ApplyOutcome.failure` with the statement's kind and index), mapped by the editor to the display row, which is highlighted; infrastructure failures are errors.
- **Conflict recovery.** "Reload" after a conflict discards all pending changes (after a confirmation) and re-reads the page; re-basing the other edits onto fresh rows is left for later.
- **Editors.** A dialog (type-checked text input, boolean select, JSON textarea, Set NULL / Set DEFAULT) rather than in-canvas overlay editors. Date/time values are typed as text in the database's format with a format hint; enum columns use the text editor (the database validates). Binary columns are read-only. SQLite cannot `SET col = DEFAULT`, so that action is disabled for loaded rows there.
- **Writes confirmation.** Connections with "confirm writes" ask once before a submit; read-only connections never enable editing.
- **Output log.** A table tab has no Output pane, so submitted statements are not logged there; Preview SQL shows them before submit.

### Manual checks left for a human
- Glide scroll smoothness at 1,000,000 rows.
- Canvas rendering (headers, FK underline, edited ring, row tints) on macOS (WKWebView) and Windows (WebView2).

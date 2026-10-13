## Context

The table editor already has the machinery: `ColumnarStore` holds rows, `ChangeSet` stages edits, `changes_preview` and `changes_apply` generate and run parameterised DML with optimistic checks, and the pending bar, preview dialog and record panel exist. The console's `ResultsPanel` renders the same `ResultGrid` read-only. Drivers already report `source_table` and `source_column` for PostgreSQL, MySQL/MariaDB and SQLite. The design reuses all of this and adds the missing middle: deciding what a result's columns map to, and wiring the editing controls and the transaction behaviour into the console.

Reference behaviour: DataGrip's Result tab (https://www.jetbrains.com/help/datagrip/services-tool-window.html#db_result_tab) and "Copy and paste inside the editor" (https://www.jetbrains.com/help/datagrip/update-data-in-data-editor.html#copy_and_paste_inside_the_editor). Those pages describe the controls and the paste behaviour; the editability rules below are Clew's own decisions, not taken from DataGrip's documentation.

## Goals / Non-Goals

**Goals:** edit what you queried, safely; one editing engine for table editor and results; submit that respects the console's transaction; paste that works with spreadsheets and CSV; exact aggregates.
**Non-Goals:** editing views, aggregates or unions; using ctid/ROWID to identify keyless rows; Chart and geo views; Copy to Database and Compare Data (candidates for later changes); two-way editing of joined rows' non-target tables.

## Decisions

### Edit target resolution (`src-tauri/src/editability/`)
`resolve(statement, columns, session) -> EditPlan | ReadOnly(reason)`:
1. Group columns by `(source_schema, source_table)` from driver provenance; columns without provenance are "unmapped".
2. If no provenance at all (Oracle, SQL Server, ClickHouse, DuckDB, MongoDB tabular, Redis), run `analyze(statement)` with `sqlparser` for the dialect: accept only `SELECT` with one table in `FROM`, no `JOIN`, `GROUP BY`, `DISTINCT`, set operations or window functions; map projected plain identifiers (with aliases) to table columns by name. Anything else, or a parse error, is read-only. Analysis marks the plan `inferred` so tests and the UI can tell.
3. For each candidate table load keys and column flags from the introspection cache (PK, then unique non-null index; identity/generated/computed flags; `is_view`).
4. A table is available when all its key columns are mapped to result columns; unavailable tables report the missing key columns. One available table is chosen automatically; several: first in `FROM` order, user can switch.
5. Output: edit target, `column_map` (result column index → table column), key column indexes, per-column editability and reasons, or the read-only reason in the vocabulary of the spec.
Results are re-resolved when the statement re-runs; introspection is cached per connection so resolution costs no round trip after the first.

### One engine, two hosts
`ChangeSet` already works on a `ColumnarStore`. Generalise it with a `ColumnMap` so edits made on result column `amount` become `SET total = $1`, and key lookups use the key column indexes. The table editor uses the identity map. `ChangeRequest` (Rust) gains `target: { schema, table }`, `column_map`, `key_columns` and `old_values_columns`; the existing table editor path fills it with identity values.

### Submit and savepoints
`changes_apply(mode)`:
- `own_transaction` (auto-commit consoles and the table editor): BEGIN, statements, COMMIT.
- `in_session_transaction` (manual consoles): if no transaction is open, begin one; then `SAVEPOINT clew_submit_<n>`, run statements, `RELEASE SAVEPOINT` on success; on failure `ROLLBACK TO SAVEPOINT` (and release), leaving the transaction as it was. Dialect map: PostgreSQL, MySQL/MariaDB, SQLite, Oracle: `SAVEPOINT`; SQL Server: `SAVE TRANSACTION name` / `ROLLBACK TRANSACTION name`; ClickHouse: no transactions, so results from ClickHouse are read-only anyway. This matters on PostgreSQL where any error aborts the whole transaction unless a savepoint is used.
The session's statement counter (shown in the toolbar chip) increments by the number of statements submitted.

### Read-back after submit
After success, rows are re-read by key from the target (`SELECT <mapped columns> FROM target WHERE key IN (…)`, or `RETURNING` where the driver supports it: PostgreSQL, SQLite, MariaDB, Oracle `RETURNING INTO`). Values replace the grid's values; inserted rows get their keys; computed columns (no source) are flagged stale in the store (`stale: true` per column per row group) and rendered italic.

### Shared rows
`ChangeSet` keys edits by the target key tuple, not by row index. A secondary index maps key → all result row indexes; rendering and edits fan out. One statement per key.

### Paste engine (`src/features/grid/paste/`)
Pure functions plus a staging adapter:
- `detect(text) -> { format, delimiter, hasHeader, table: string[][] }` scoring candidates: JSON (valid parse of array), Markdown (pipe rows with a `---` separator line), then delimiters tab, comma, semicolon, pipe by consistency of field counts across the first 50 lines (RFC 4180 quoting). A header is assumed when its names match grid columns (case-insensitive) or every header cell is non-numeric while the next row has numerics.
- `plan(table, selection, columns, editable) -> { assignments, skippedColumns, errors, extraRows }` using the same per-kind parsers as the cell editors (`editValue.ts`), so pasted values go through identical validation.
- `apply(plan)` stages all assignments as one undo group in `ChangeSet`.
Glide Data Grid provides the clipboard hook; copying inside the grid writes TSV plus a private MIME type carrying typed values so Clew-to-Clew paste is lossless (NULL vs empty string, exact decimals).

### Aggregate view
Numeric kinds are summed with BigInt on a scaled integer (scale taken from the column type or the longest fraction digits) so decimals never pass through floating point; floats use plain doubles and are labelled approximate. Selections over 100,000 cells are aggregated in a worker.

### Find, local filter, view as
`ColumnarStore` gains a `visibleRows` index array that find, local filter and sort share; edits and the pending bar operate on store rows, so filters never lose changes. Tree reuses the document browser's tree component; Text reuses the exporter's formatters (a TypeScript port shared with Copy as); both read from the same extractor options store.

### Value editor
A side panel hosting a CodeMirror instance (language per Highlight as). Display as is a pure conversion layer (`bytes → text|hex|base64|uuid`, `number → formatted`) on read; the edit path converts back with the same codec and rejects ambiguous round trips. Load and Save use the dialog plugin and a Rust command limited to the picked path, streaming in chunks; values truncated in the grid are fetched in full (`value_fetch_full`) before saving.

### Console toolbar and results
`ResultsPanel` gets a `ResultToolbar` composed of groups (tabs, edit chip and row operations, tools, view-as, auto-refresh, export, options). The toolbar wraps rather than clips, and every popover goes through the shared overlay helper. Auto-refresh uses the guard's classifier (`read` only) and a timer owned by the console runtime; paging mode is a window over `ColumnarStore` plus `fetchMore`.

### Shortcuts
Registered in the grid scope: Mod+Enter submit (the editor scope keeps Mod+Enter = run, resolved by focus), Mod+Alt+Shift+Enter, Mod+N, Mod+Shift+D, Mod+Backspace, Mod+Z, Mod+Shift+Z, Mod+Alt+Z, Mod+Alt+N, Mod+Alt+D, Mod+V, Mod+Shift+V, Mod+F, Mod+G, Mod+Shift+C, Mod+Alt+Up/Down. The registry's conflict detection runs in tests for all of them.

## Risks / Trade-offs

- [A result looks editable but updates a different row than the user expects (fan-out)] → Key-based statements, the shared-row notice, and Preview SQL before every submit.
- [Inference from statement parsing misses a dialect feature] → Anything unparseable or unusual is read-only; provenance from the driver wins over inference.
- [Keys changed by triggers or defaults] → Read-back by key after submit shows the real values.
- [Savepoint syntax differences] → Per-driver savepoint adapter with integration tests on every driver that supports transactions.
- [Mod+Enter doing two things] → Decided by focus (editor vs grid), shown in tooltips, covered by a test.
- [Paste of untrusted text staging many cells] → Limits (confirm at 10,000 cells, refuse at 100,000), validation before staging, one undo step.

## Open Questions

- Updatable views and keyless tables via ROWID/ctid are excluded for safety; revisit if users ask.
- Should "Overwrite" after a conflict log what was overwritten in the History tab? (Likely yes; decide during implementation.)

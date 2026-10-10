## Why

Seeing and changing data is the other half of a database IDE. Query results need a fast, readable grid, and tables need a DataGrip-style editor: filter with a real WHERE clause, page through millions of rows, edit cells safely with every change staged and reviewable before it touches the database.

## What Changes

- Add a shared result grid (canvas-rendered, virtualized) used by console results and the table editor: row numbers, two-line headers (name + type), typed value colors, italic `NULL`, FK values as links, sorting, column resize/reorder/hide, range selection, copy as TSV/CSV/JSON/SQL INSERT, transpose.
- Add the table editor tab from `design/canvas/DataGrid.dc.html`: breadcrumb, Data / Structure / Indexes / Relations / DDL views, WHERE and ORDER BY inputs, paging toolbar, Columns picker.
- Add inline editing staged as pending changes: edited cells, inserted rows and deleted rows with distinct colors; the pending bar with Preview SQL, Revert all and Submit (Mod+S) applied in one transaction.
- Add the record panel: the selected row as a vertical key/value list, References (follow FK) and Referenced by (counts, open filtered).
- Add export of a result or table to CSV, TSV, JSON, Markdown and SQL INSERTs.

Canvas screens implemented: `design/canvas/DataGrid.dc.html`, the result grid in `design/canvas/Main.dc.html`.

## Capabilities

### New Capabilities
- `data-grid`: the shared grid component, its rendering, selection, copy, sort, column management and export.
- `table-editor`: the table tab with filter/sort/paging, structure views, staged editing with submit, and the record panel.

### Modified Capabilities
- (none)

## Impact

- Frontend: `src/features/grid/` (ResultGrid on @glideapps/glide-data-grid, cell renderers, theme from tokens, export dialog), `src/features/table-editor/`.
- Rust: `table_query` (filtered/sorted/paged SELECT with exact or estimated count), `changes_preview` and `changes_apply` (generate and run DML in a transaction), `export_result` (streams to file), driver hooks for primary-key detection and DML quoting.

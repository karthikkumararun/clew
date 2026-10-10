## 1. Grid component

- [ ] 1.1 Add @glideapps/glide-data-grid; build `ResultGrid` with a token-derived theme, row numbers and two-line headers (spec: data-grid › Grid rendering)
- [ ] 1.2 Implement `ResultStore` (columnar batches, O(1) cell lookup, append and replace pages)
- [ ] 1.3 Custom cell renderers: typed colors, right-aligned numbers, italic NULL, FK underline, truncated marker
- [ ] 1.4 Cell viewer (Shift+Enter): JSON pretty view, bytes hex, long text (spec: data-grid › Cell viewer)
- [ ] 1.5 Test: store lookups; renderer picks the right style per value kind

## 2. Selection, copy, sort, columns

- [ ] 2.1 Range/row/column selection; Mod+C as TSV; Copy as CSV / JSON / Markdown / SQL INSERT (spec: data-grid › Selection and copy)
- [ ] 2.2 Header sort cycle with accent arrow; client-side sort notice for partial console results (spec: data-grid › Sorting and columns)
- [ ] 2.3 Column resize (auto-fit on double-click), reorder, hide via Columns menu
- [ ] 2.4 Transpose toggle (spec: data-grid › Transpose)
- [ ] 2.5 Replace the console's interim table with `ResultGrid`
- [ ] 2.6 Test: copy formats and dialect quoting; sort cycle

## 3. Export

- [ ] 3.1 Rust `export_result` streaming writer for CSV/TSV/JSON/JSONL/Markdown/INSERT with progress channel and cancel (spec: data-grid › Export)
- [ ] 3.2 Export dialog (format, scope loaded/all, header, delimiter, NULL text, date format)
- [ ] 3.3 Test: export 100k rows from SQLite with bounded memory; cancel deletes the file

## 4. Table editor tab

- [ ] 4.1 Register the `table` tab kind: breadcrumb, view switcher, env badge, Open in console (spec: table-editor › Table editor tab)
- [ ] 4.2 Rust `table_query` with dialect paging and exact/estimated count
- [ ] 4.3 WHERE / ORDER BY inputs with column completion, error under input, quick filter from cell (spec: table-editor › Filter and order)
- [ ] 4.4 Paging toolbar with page size and "Rows x–y of n · ms" (spec: table-editor › Paging and counts)
- [ ] 4.5 Structure / Indexes / Relations / DDL views (spec: table-editor › Structure, indexes, relations and DDL views)
- [ ] 4.6 Test: query building per dialect; bad filter keeps rows

## 5. Editing

- [ ] 5.1 Editability check (single table + PK/unique key + not read-only) with the read-only reason label (spec: table-editor › Staged inline editing)
- [ ] 5.2 `ChangeSet` model with undo/redo; derived cell/row states and markers (+, −, edited ring)
- [ ] 5.3 Type-specific cell editors, Set NULL / Set DEFAULT, add/delete row shortcuts
- [ ] 5.4 Rust `changes_preview` and `changes_apply` (bound params, optimistic check, single transaction, RETURNING reload)
- [ ] 5.5 Pending bar with breakdown, Preview SQL dialog, Revert all, Submit (Mod+S); failure keeps changes and highlights the failing row (spec: table-editor › Pending changes bar and submit)
- [ ] 5.6 Guard navigation (close tab, page, filter) with Submit / Discard / Cancel
- [ ] 5.7 Test: generated SQL golden files for PG and SQLite; conflict detection; rollback on failure

## 6. Record panel

- [ ] 6.1 Record panel with key/value list, "was <old>" for changed values, Copy as JSON, Mod+Shift+R toggle (spec: table-editor › Record panel)
- [ ] 6.2 REFERENCES (FK targets with label columns) and REFERENCED BY (counts) with open-filtered navigation
- [ ] 6.3 Test: follow reference opens filtered table

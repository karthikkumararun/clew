## Why

Today rows can only be edited in the Table editor tab. In DataGrip, the result of any query run in a console is itself an editable grid: change a cell, add or delete a row, review the generated SQL, submit, and commit as part of the console's transaction. That is the workflow Clew should have: query what you need, fix it right there, without opening the table first. DataGrip's Result tab also carries a set of tools around the grid (paste from the clipboard or CSV, find and filter on the page, aggregate of selected cells, tree and text views, a value editor, auto-refresh) that Clew's console results lack.

## What Changes

- **Editable query results:** a result is editable when its columns can be traced to one table whose key is in the result. Clew uses the driver's column provenance and falls back to analysing simple statements. Joined results offer a choice of table to edit. Everything else is read-only with a clear reason and, where possible, a fix.
- **Editing in the console Result tab:** type-aware cell editing, add, clone and delete rows, undo, revert selected or all, preview SQL, Submit (Mod+Enter in the grid) and Submit and commit, with the same pending-change colours as the table editor.
- **Transaction-aware submit:** auto-commit mode commits the submit; manual mode sends it to the console's open transaction inside a savepoint, so a failed submit never ruins the transaction. A Commit and Roll back control sits in the result and the toolbar.
- **Paste:** paste cells inside the grid, paste external CSV, TSV, Markdown tables or JSON with format detection and an "Interpret as" choice, paste as new rows, with header mapping and per-value validation.
- **Grid tools for every result:** aggregate view of selected cells, find on page, per-column local filter, View as Table / Tree / Text with Transpose, a value editor panel with Display as and Load/Save file, extractor options (skip computed and generated columns), Reset view, View query, Copy query to console, Go to row and Related rows.
- **Console result tab:** auto-refresh of read results, optional page-by-page navigation, Output tab tools (soft wrap, auto-scroll, clear, pause) and Plan tab details (copy native plan, node details).
- **Driver contract:** columns report their source schema, table and column and whether they are updatable.

Canvas screens implemented: `design/canvas/ResultEditing.dc.html` (the console Result tab in editing state) and `design/canvas/ResultEditingStates.dc.html` (read-only reasons, table chooser, paste dialogs, production confirmation, post-submit, conflict, local filter, value editor, View as, menus).

Not in this change (candidates for later): Chart view and geo viewer, Copy to Database, Compare Data.

## Capabilities

### New Capabilities
- `result-editing`: editability rules, editing, row operations, pending changes, submit and commit, safeguards and shortcuts for query results.

### Modified Capabilities
- `data-grid`: adds paste, aggregate view, find, local filter, View as, value editor, extractor options and grid options requirements (shared with the table editor).
- `sql-console`: adds auto-refresh, result paging, Output tab tools and Plan tab details.
- `driver-framework`: adds result column provenance.

## Impact

- Rust: `ColumnMeta` gains `source_schema` and `source_updatable`; new `src-tauri/src/editability/` (resolver, statement analysis with `sqlparser`); `changes_apply` gains an in-session-transaction mode with savepoints; `changes_refetch` to read edited rows back.
- Frontend: `src/features/results/` (editing controller, chip, toolbar, pending bar reuse), `src/features/grid/paste/`, `src/features/grid/tools/` (aggregate, find, local filter, view-as, value editor), console results panel changes.
- Reuses `ChangeSet`, `changes_preview`, `changes_apply` and the pending bar from the table editor.
- Depends on `add-sql-console`, `add-data-grid` and `add-production-safeguards` (all done).

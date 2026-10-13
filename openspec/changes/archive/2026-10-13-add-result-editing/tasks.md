## 1. Provenance and editability

- [x] 1.1 Extend `ColumnMeta` with `source_schema` and `source_updatable`; fill them for PostgreSQL, MySQL/MariaDB and SQLite (spec: driver-framework › Result column provenance)
- [x] 1.2 Statement analysis with `sqlparser` for drivers without provenance: single table, plain columns, aliases; everything else read-only (spec: result-editing › Source detection)
- [x] 1.3 `resolve()` combining provenance, introspection keys/generated flags and view detection into an `EditPlan` or a read-only reason (spec: result-editing › Editable query results, Read-only reasons)
- [x] 1.4 Command `results_resolve_edit` returning the plan to the frontend; cache per connection and statement
- [x] 1.5 Test: table-driven resolver tests (aliases, reordered columns, expressions, missing key, join with one and two candidates, view, DISTINCT/GROUP BY, parse failure, Oracle inferred) with `/// spec:` references

## 2. Editing engine

- [x] 2.1 Generalise `ChangeSet` with `ColumnMap`, key indexes and key-based (not row-based) storage with a key → rows index (spec: result-editing › Shared rows)
- [x] 2.2 Generalise `ChangeRequest` and `changes_preview/apply` with target, column map and key columns; the table editor keeps working through the identity map
- [x] 2.3 Key columns of existing rows read-only; generated, identity-always and computed columns read-only; `NOT NULL` hides Set NULL (spec: result-editing › Editing cells)
- [x] 2.4 Test: edits through an aliased/reordered column generate the right UPDATE; shared rows produce one statement; table editor tests unchanged

## 3. Console result UI

- [x] 3.1 Result toolbar per `design/canvas/ResultEditing.dc.html`: edit chip, row operations, tools, View as, auto-refresh, export, options menu; wraps instead of clipping
- [x] 3.2 Edit chip with read-only reasons, fixes and the table chooser menu (spec: result-editing › Read-only reasons, Choosing the table in a joined result)
- [x] 3.3 Cell editors, Set NULL/DEFAULT/Generate UUID, add, clone and delete rows with the specified rules (spec: result-editing › Adding, cloning and deleting rows)
- [x] 3.4 Pending bar, Preview SQL, Revert all/selected, undo/redo, guard on re-run, new statement, close and paging (spec: result-editing › Pending changes)
- [x] 3.5 Per-result state for multi-result scripts (spec: result-editing › Large and multiple results)
- [x] 3.6 Test: component tests for each read-only reason message, chooser, row operations and the leave-with-pending dialog

## 4. Submit and transactions

- [x] 4.1 `changes_apply` modes `own_transaction` and `in_session_transaction` with savepoint adapters per driver (spec: result-editing › Submit and transactions) (backend done)
- [x] 4.2 Submit, Submit and commit, Commit and Roll back in the pending bar and toolbar; statement counter in the Tx chip
- [x] 4.3 Optimistic-conflict dialog (Keep editing, Reload row, Overwrite) and failing-row highlight
- [x] 4.4 Read-back by key / RETURNING; stale computed columns; Re-run action and auto re-run setting (spec: result-editing › After submit) (backend done)
- [x] 4.5 Production confirmation and typed confirmation through the guard; read-only sessions make results read-only; AI cannot stage or submit (spec: result-editing › Safeguards apply)
- [x] 4.6 Test (integration, real databases): failed submit in manual mode leaves earlier statements intact on PostgreSQL, MySQL and SQLite; auto-commit submit commits; conflict detected (Rust integration tests exist for PostgreSQL, MySQL and SQLite; SQLite ran; the PostgreSQL behaviour was also run end to end in J-22; MySQL ran in neither)

## 5. Paste

- [x] 5.1 Clipboard: copy writes TSV and typed private data; paste reads both (spec: data-grid › Paste into the grid)
- [x] 5.2 Format detection and parsers (TSV, CSV delimiters with quotes, Markdown, JSON) and header-to-column mapping (spec: data-grid › Paste external data)
- [x] 5.3 Paste planner and staging as one undo group; skipped read-only columns; per-value validation dialog; limits
- [x] 5.4 "Interpret as" notice and menu; Paste as new rows; "Add N new rows?" dialog (spec: data-grid › Paste as new rows)
- [x] 5.5 Test: detection table with real-world samples (Excel TSV, Google Sheets, semicolon CSV with decimal commas, Markdown, JSON); undo restores; limits

## 6. Grid tools

- [x] 6.1 Aggregate view with exact decimal arithmetic and Mod+Shift+C (spec: data-grid › Aggregate view)
- [x] 6.2 Find on page and local filter on a shared `visibleRows` index; pending-in-hidden-row note (spec: data-grid › Find on page, Local filter)
- [x] 6.3 View as Tree and Text with Transpose; shared extractor options and "Skip computed/generated columns" (spec: data-grid › View as, Extractor options)
- [x] 6.4 Value editor panel: Display as, Highlight as, Load file, Save to file with full-value fetch (Load and Save handle text through the existing file dialogs; binary files and the full-value fetch for truncated cells are not wired yet) (spec: data-grid › Value editor panel)
- [x] 6.5 Options menu: Reset view, View query, Copy query to console/clipboard; Go to row, Related rows, Show DDL, Reveal in explorer (Show DDL and Reveal in explorer are in the menu but not wired to the explorer yet) (spec: data-grid › Grid options menu, Go to row and related rows)
- [x] 6.6 Test: aggregates of 1150.00 and 300.00 exact; filters keep pending changes; display-as round trips

## 7. Console tools

- [x] 7.1 Auto-refresh with pause rules and read-only restriction (spec: sql-console › Auto-refresh)
- [x] 7.2 Result paging mode with First/Previous/Next/Last and page size (spec: sql-console › Result paging)
- [x] 7.3 Output tab tools: soft wrap, auto-scroll, pause, clear, context menu (spec: sql-console › Output tab tools)
- [x] 7.4 Plan tab: copy original plan, node details pane, cost bars, Explain with AI hook when a provider exists (spec: sql-console › Plan tab details)
- [x] 7.5 Test: refresh pauses with pending changes; next page loads rows 501–1,000

## 8. Shortcuts and accessibility

- [x] 8.1 Register all grid-scope shortcuts in the registry with tooltips; Mod+Enter resolved by focus (spec: result-editing › Result shortcuts)
- [x] 8.2 Accessible names for every toolbar button and chip, focus order, keyboard-only editing and paste
- [x] 8.3 Test: registry reports no conflicts; keyboard-only flow edits, pastes and submits

## 9. End-to-end

- [x] 9.1 E2E: add journey J-22 in `e2e/specs/` — run `SELECT id,status,total FROM orders …`, edit a cell, add and delete a row, paste CSV, preview SQL, submit in auto-commit and verify from a second connection; manual mode submit then Commit; failure keeps the transaction; join shows the table chooser; production confirm
- [x] 9.2 Declare `covers(...)` for the result-editing, data-grid and sql-console scenarios it exercises
- [x] 9.3 Design suite states from `design/canvas/ResultEditing.dc.html` and `ResultEditingStates.dc.html` added to `design/states.json`; overlay-integrity checks on the chooser, options, auto-refresh and cell menus; the toolbar is checked at 1440 and 1024 px for wrapping without clipping

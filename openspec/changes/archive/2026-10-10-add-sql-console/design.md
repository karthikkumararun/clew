## Context

Depends on `add-driver-framework` (sessions, streaming, completion snapshot, splitter rules), `add-connection-management` and `add-app-shell` (tab kinds, shortcuts, status items). Canvas: `design/canvas/Main.dc.html` (editor, autocomplete, results header) and `design/canvas/AIAssistant.dc.html` (Output tab with an error, red squiggle).

## Goals / Non-Goals

**Goals:** DataGrip-grade editing feel; never freeze the UI on huge results; accurate statement detection.
**Non-Goals:** a visual query builder, a stored-procedure debugger, or SQL formatting options beyond one sensible default.

## Decisions

### CodeMirror 6 over Monaco
CM6 is modular (~150 KB for what we use vs ~2 MB for Monaco), themes cleanly from CSS variables, has first-class SQL dialects (`PostgreSQL`, `MySQL`, `MariaSQL`, `MSSQL`, `SQLite`, `StandardSQL`) and an extensible completion API. Monaco's SQL support would need a custom language anyway.

### Editor extensions (`src/features/console/editor/`)
- `theme.ts`: EditorView.theme + HighlightStyle mapped to `--syn-*` tokens.
- `statementField.ts`: StateField computing statement ranges using the same splitting rules as Rust `split.rs` (shared fixtures in `tests/fixtures/split/`), plus decorations for the current-statement tint and the gutter ▶ marker.
- `completion.ts`: CompletionSource using the schema snapshot; alias resolution by scanning the current statement's FROM/JOIN clauses with the lang-sql syntax tree.
- `diagnostics.ts`: `@codemirror/lint` diagnostics from execution errors (position → range of the token at that offset).
- `keymap.ts`: binds Mod+Enter, Mod+Shift+Enter, Mod+., Mod+Shift+E, Mod+Shift+F through the shell's shortcut registry (editor scope).
- Formatting: `sql-formatter` package with the matching dialect.

### Results
`ResultsPanel` holds a list of `ResultSet` objects fed by `useQueryRun()`. The Result tab renders the grid from `add-data-grid` in read-only-unless-editable mode; until then a basic virtualized table. Output is an append-only log component (mono 12.5px, timestamps `--text-dim`).

### Explain
Run `EXPLAIN (FORMAT JSON)` (PG) / `EXPLAIN QUERY PLAN` (SQLite) through the session; render a tree with node, relation, rows, cost. Explain Analyze wraps the statement in `BEGIN … ROLLBACK` for writes.

### History storage
`clew.db` table `history(id INTEGER PK, connection_id TEXT, database TEXT, sql TEXT, started_at INTEGER, duration_ms INTEGER, rows INTEGER, outcome TEXT)` with an index on `(connection_id, started_at DESC)`; search uses `LIKE` (FTS5 later if needed). Recording happens in Rust after each statement so it cannot be skipped by the UI.

### Files
`@tauri-apps/plugin-dialog` for pickers; reading/writing via our own commands limited to paths the user picked in this session (kept in an allow-set) — no broad fs scope. File watching with `notify` for open files.

## Risks / Trade-offs

- [Splitter drift between TS and Rust] → shared fixture corpus run in both test suites.
- [Completion on huge schemas] → snapshot is fetched once per database and indexed into a prefix map; completion runs in < 16 ms for 50k columns.
- [Explain Analyze side effects] → always rolled back; still requires explicit confirmation, and is blocked on read-only production sessions.

### Decisions made during implementation
- **Runtime outside React.** Only the active tab is mounted, so a console's session, running query and results live in a per-tab `ConsoleRuntime` (`features/console/runtime.ts`) that the view subscribes to. A query keeps running, and its rows keep arriving, while another tab is on screen. The session opens on the first run and closes with the tab; its id is mirrored on the tab state for the connection chip.
- **Statement detection.** `editor/statements.ts` is a TypeScript port of `split.rs`, run against the shared fixture corpus. The editor adds two rules on top of it: a blank line ends a statement, and a statement starts at its first token (comments above it are not part of it). `Run script` still sends the whole text to the server-side splitter.
- **Completion.** Table aliases are found by scanning the statement's FROM / JOIN / UPDATE / INTO clauses with regular expressions rather than the lang-sql syntax tree; it covers aliases, `AS`, schema-qualified names and comma lists, and is cheap enough for every keystroke. Function signatures come from a built-in list per dialect because the snapshot only carries function names.
- **Keys.** App-level keys go through the shortcut registry in the `editor` scope (run, run script, cancel, explain, format, open, save, save as). `Mod+O` therefore opens a SQL file inside an editor and still opens a database file elsewhere. `Mod+Enter` and `Escape` are removed from CodeMirror's default keymap; its own editing keys (`Mod+/` comment, `Mod+F` find, undo, multi-cursor) stay.
- **Explain.** PostgreSQL uses `EXPLAIN (FORMAT JSON)`, MySQL/MariaDB `EXPLAIN FORMAT=JSON` (`EXPLAIN ANALYZE` tree on MySQL), SQLite `EXPLAIN QUERY PLAN`; other drivers show the raw rows. SQLite has no ANALYZE. ANALYZE of a write needs confirmation, runs in `BEGIN … ROLLBACK` (or a savepoint when a manual transaction is open) and is refused on a read-only connection.
- **Transactions.** Manual mode issues the driver's `BEGIN` on the console's own session before the first statement, counts the statements that follow, and ends with `COMMIT` / `ROLLBACK`. The close and mode-switch prompts use the same state.
- **Files.** The WebView never receives a file system. File dialogs run in Rust (`file_open_dialog`, `file_save_dialog`); only paths picked there, plus files inside a connection's Scripts folder, can be read or written (`files.rs`, remembered in `allowed-files.json`). `plugin-fs` is not used. Open files are watched with `notify`; a clean console reloads, one with edits asks.
- **History** is recorded inside `SessionManager::execute` (not in the Tauri command), after each statement, with its outcome, duration and rows. Transaction-control statements (`BEGIN`, `COMMIT`, `ROLLBACK`) and statements the app runs itself (switching schema, ending transactions on disconnect) are not recorded. Retention (10,000 per connection) is applied on every insert; paging uses the last entry id as the cursor.
- **Results.** Until `add-data-grid` lands the Result tab is a read-only virtualized table. Export offers Copy as CSV / TSV / JSON for now; saving to a file arrives with the grid's export.

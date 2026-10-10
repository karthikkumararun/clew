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

## Why

The SQL console is where a programmer spends most of their time in a database IDE: writing queries with good completion, running one statement or a whole script, seeing results and errors immediately, and finding past queries again.

## What Changes

- Add a console tab kind: a CodeMirror 6 SQL editor bound to a connection session, matching `design/canvas/Main.dc.html` (13px/20px JetBrains Mono, 56px gutter, current-statement tint, ▶ run marker).
- Dialect-aware highlighting and schema-aware autocomplete (tables, columns with types, aliases, functions, keywords) with the canvas popup style.
- Run current statement (Mod+Enter), run selection, run script (Mod+Shift+Enter), cancel (Mod+. / Esc), Explain (plan in the results panel).
- Results panel under the editor with a draggable splitter and tabs: Result (data grid), Output (log of statements, timings, rows affected, errors), Explain plan, History.
- Error reporting with the error position underlined in the editor.
- Transaction mode per console (Auto-commit / Manual) with Commit and Rollback buttons and a pending-transaction indicator.
- Query history (per connection, searchable) and saved `.sql` files (open, save, save as; tab shows the file name and a dirty dot).

Canvas screens implemented: editor, autocomplete popup, results tabs and status items in `design/canvas/Main.dc.html`; the Output tab and inline error underline in `design/canvas/AIAssistant.dc.html`.

## Capabilities

### New Capabilities
- `sql-console`: the SQL editor, completion, execution modes, results panel, errors, transaction controls and file handling.
- `query-history`: recording, searching and re-opening executed statements.

### Modified Capabilities
- (none)

## Impact

- Frontend: `src/features/console/` (ConsoleTab, editor extensions, completion source, ResultsPanel, OutputLog, ExplainView, HistoryPanel).
- Rust: history table + commands in the app store; file read/write commands scoped to user-picked paths (dialog plugin).
- Dependencies: `@codemirror/*`, `@codemirror/lang-sql`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs` (scoped).
- The Result tab uses the grid component from `add-data-grid`; until that lands it renders a simple read-only table.

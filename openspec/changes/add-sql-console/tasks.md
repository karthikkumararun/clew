## 1. Console tab

- [x] 1.1 Register the `console` tab kind with session lifecycle (open on first run, close with tab), title/subtitle, env stripe, restore text after restart (spec: sql-console › Console tabs)
- [x] 1.2 Mod+T new console with connection picker fallback
- [x] 1.3 Test: open/close lifecycle; restore text

## 2. Editor

- [x] 2.1 CodeMirror setup with the token theme, gutter, dialect per driver, font size from settings (spec: sql-console › SQL editor)
- [x] 2.2 Statement detection StateField + current-statement tint + ▶ gutter marker, using the shared split fixtures
- [x] 2.3 Comment toggle, find/replace, multi-cursor, format SQL (sql-formatter)
- [x] 2.4 Test: statement ranges over the shared fixture corpus

## 3. Completion

- [x] 3.1 Fetch and cache the completion snapshot per connection/database; refresh after successful DDL (spec: sql-console › Schema-aware completion)
- [x] 3.2 Completion source: keywords, schemas, tables, columns with types, aliases, functions with signatures
- [x] 3.3 Popup styling per canvas (icons, dim signature, right-aligned kind, footer hint)
- [x] 3.4 Test: alias `o.` lists orders columns; keyword completion before snapshot arrives

## 4. Running

- [x] 4.1 Run current statement / selection / script; toolbar Run ↔ Cancel; elapsed timer (spec: sql-console › Run modes)
- [x] 4.2 Cancel via Mod+. / Esc; busy-session prompt
- [x] 4.3 Results panel with splitter (height per tab), tabs Result / Output / Explain plan / History, range label, re-run, filter, transpose, Export menu placeholder (spec: sql-console › Results panel)
- [x] 4.4 Multiple result sets as sub-tabs; fetch-more on scroll
- [x] 4.5 Output log entries (statement, timing, rows affected, cancelled)
- [x] 4.6 Test: run modes with mocked IPC; cancel; multiple results

## 5. Errors and explain

- [x] 5.1 Error display in Output + lint diagnostic squiggle at the server position (spec: sql-console › Errors in the editor)
- [x] 5.2 Explain / Explain Analyze with confirmation and rollback for writes (spec: sql-console › Explain plan)
- [x] 5.3 Test: error position maps to the right token; explain tree renders a fixture plan

## 6. Transactions

- [x] 6.1 Tx mode selector, Commit / Rollback buttons, pending indicator with statement count (spec: sql-console › Transaction mode)
- [x] 6.2 Close-with-open-transaction prompt
- [x] 6.3 Test: manual mode keeps a transaction open across runs (SQLite)

## 7. Files and status bar

- [x] 7.1 Open / Save / Save as with dialog plugin and a user-picked path allow-set; dirty dot (spec: sql-console › SQL files)
- [x] 7.2 Watch open files and reload or ask on external change
- [x] 7.3 Status bar items: Ln/Col, encoding, dialect, transaction state (spec: sql-console › Status bar items)
- [x] 7.4 Test: save/reload flow with a temp file

## 8. Query history

- [x] 8.1 Rust: `history` table migration, record after every statement, retention 10,000 per connection (spec: query-history › Record executed statements)
- [x] 8.2 Commands `history_list(connection, query, cursor)`, `history_clear(connection?)`
- [x] 8.3 History tab UI with search, entry detail, Insert / Open in new console / Copy (spec: query-history › Browse and search history)
- [x] 8.4 Clear history with confirmation (spec: query-history › Clear history)
- [x] 8.5 Test: recording outcomes incl. error and cancelled; retention trimming; search

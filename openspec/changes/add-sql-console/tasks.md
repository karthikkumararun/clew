## 1. Console tab

- [ ] 1.1 Register the `console` tab kind with session lifecycle (open on first run, close with tab), title/subtitle, env stripe, restore text after restart (spec: sql-console › Console tabs)
- [ ] 1.2 Mod+T new console with connection picker fallback
- [ ] 1.3 Test: open/close lifecycle; restore text

## 2. Editor

- [ ] 2.1 CodeMirror setup with the token theme, gutter, dialect per driver, font size from settings (spec: sql-console › SQL editor)
- [ ] 2.2 Statement detection StateField + current-statement tint + ▶ gutter marker, using the shared split fixtures
- [ ] 2.3 Comment toggle, find/replace, multi-cursor, format SQL (sql-formatter)
- [ ] 2.4 Test: statement ranges over the shared fixture corpus

## 3. Completion

- [ ] 3.1 Fetch and cache the completion snapshot per connection/database; refresh after successful DDL (spec: sql-console › Schema-aware completion)
- [ ] 3.2 Completion source: keywords, schemas, tables, columns with types, aliases, functions with signatures
- [ ] 3.3 Popup styling per canvas (icons, dim signature, right-aligned kind, footer hint)
- [ ] 3.4 Test: alias `o.` lists orders columns; keyword completion before snapshot arrives

## 4. Running

- [ ] 4.1 Run current statement / selection / script; toolbar Run ↔ Cancel; elapsed timer (spec: sql-console › Run modes)
- [ ] 4.2 Cancel via Mod+. / Esc; busy-session prompt
- [ ] 4.3 Results panel with splitter (height per tab), tabs Result / Output / Explain plan / History, range label, re-run, filter, transpose, Export menu placeholder (spec: sql-console › Results panel)
- [ ] 4.4 Multiple result sets as sub-tabs; fetch-more on scroll
- [ ] 4.5 Output log entries (statement, timing, rows affected, cancelled)
- [ ] 4.6 Test: run modes with mocked IPC; cancel; multiple results

## 5. Errors and explain

- [ ] 5.1 Error display in Output + lint diagnostic squiggle at the server position (spec: sql-console › Errors in the editor)
- [ ] 5.2 Explain / Explain Analyze with confirmation and rollback for writes (spec: sql-console › Explain plan)
- [ ] 5.3 Test: error position maps to the right token; explain tree renders a fixture plan

## 6. Transactions

- [ ] 6.1 Tx mode selector, Commit / Rollback buttons, pending indicator with statement count (spec: sql-console › Transaction mode)
- [ ] 6.2 Close-with-open-transaction prompt
- [ ] 6.3 Test: manual mode keeps a transaction open across runs (SQLite)

## 7. Files and status bar

- [ ] 7.1 Open / Save / Save as with dialog plugin and a user-picked path allow-set; dirty dot (spec: sql-console › SQL files)
- [ ] 7.2 Watch open files and reload or ask on external change
- [ ] 7.3 Status bar items: Ln/Col, encoding, dialect, transaction state (spec: sql-console › Status bar items)
- [ ] 7.4 Test: save/reload flow with a temp file

## 8. Query history

- [ ] 8.1 Rust: `history` table migration, record after every statement, retention 10,000 per connection (spec: query-history › Record executed statements)
- [ ] 8.2 Commands `history_list(connection, query, cursor)`, `history_clear(connection?)`
- [ ] 8.3 History tab UI with search, entry detail, Insert / Open in new console / Copy (spec: query-history › Browse and search history)
- [ ] 8.4 Clear history with confirmation (spec: query-history › Clear history)
- [ ] 8.5 Test: recording outcomes incl. error and cancelled; retention trimming; search

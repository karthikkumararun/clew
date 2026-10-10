## Why

Every feature in Clew (explorer, console, grid, document browser, AI assistant) talks to a database through the same few operations: connect, introspect, execute, stream results, cancel. Defining one driver contract in Rust, and proving it with PostgreSQL and SQLite, lets each UI feature be written once and lets more databases be added later without touching the UI.

## What Changes

- Add a Rust driver contract and a driver registry with per-driver metadata: id, display name, 2-letter badge, color token, family (`sql | document | keyvalue`), default port, connection-form kind (`network | file | uri | keyvalue`), SQL dialect and capability flags.
- Add live sessions: a small pool per connection for metadata, plus a dedicated session per editor tab, so transactions and session settings (search_path, temp tables) persist across statements.
- Add query execution that streams typed result batches to the frontend over a Tauri Channel, with paging (fetch more), row limits, cancellation and timeouts.
- Add one value model (null, bool, int, float, decimal, text, bytes, date/time types, json, uuid, array, unknown-as-text) so the grid can render and edit any driver's data.
- Add schema introspection as a lazy tree API (databases → schemas → tables/views/functions → columns/indexes/keys).
- Add SSH tunnelling (agent, key file, password) and TLS options shared by all network drivers.
- Ship two drivers: PostgreSQL and SQLite. MySQL/MariaDB/SQL Server/ClickHouse/DuckDB come in `add-more-sql-drivers`; MongoDB and Redis in `add-nosql-browser`.

No canvas screen of its own. Its output shows up in the status bar of `design/canvas/Main.dc.html` ("Connected · prod-postgres · PostgreSQL 16.2 · via SSH bastion") and powers every later change.

## Capabilities

### New Capabilities
- `driver-framework`: driver contract and registry, sessions, query execution and streaming, value model, introspection, SSH/TLS transport, and the PostgreSQL and SQLite drivers.

### Modified Capabilities
- (none)

## Impact

- New Rust modules: `src-tauri/src/drivers/{mod.rs,registry.rs,value.rs,introspect.rs,postgres/,sqlite/}`, `src-tauri/src/sessions/`, `src-tauri/src/transport/{ssh.rs,tls.rs}`.
- New Tauri commands: `drivers_list`, `session_open`, `session_close`, `query_execute`, `query_fetch_more`, `query_cancel`, `introspect_children`, `connection_test`.
- Dependencies: sqlx (postgres, sqlite, runtime-tokio, tls-rustls), russh, russh-keys, rustls, rustls-native-certs, tokio, serde_json, chrono, rust_decimal, uuid, async-trait.
- `docker-compose.yml` with PostgreSQL 16 (and an SSH bastion container) for integration tests.

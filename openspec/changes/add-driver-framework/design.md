## Context

The app shell exists (`add-app-shell`). No database code yet. Later changes (explorer, console, grid, NoSQL, AI) depend on the contract defined here, so it must cover SQL, document and key-value stores without leaking driver specifics into the UI.

## Goals / Non-Goals

**Goals:**
- One async Rust contract that every driver implements, with family-specific extensions.
- Streaming, cancellable, paged execution that never blocks the UI.
- A value model the grid can render and edit without knowing the driver.
- PostgreSQL and SQLite drivers that pass the shared conformance test suite.

**Non-Goals:**
- Loading drivers at runtime from external plugin files. v1 compiles drivers in; the registry is the seam for a plugin system later.
- Connection persistence and secrets (that's `add-connection-management`; this change accepts a fully resolved config with secrets already filled in).

## Decisions

### Contract shape
```rust
#[async_trait]
pub trait Driver: Send + Sync {
    fn meta(&self) -> &DriverMeta;
    async fn test(&self, cfg: &ResolvedConfig) -> Result<ServerInfo>;
    async fn open(&self, cfg: &ResolvedConfig) -> Result<Box<dyn Session>>;
    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> Result<Vec<TreeNode>>;
    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> Result<SchemaSnapshot>;
}

#[async_trait]
pub trait Session: Send {
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> Result<ExecSummary>;
    async fn fetch_more(&mut self, result_id: ResultId, n: usize, sink: ResultSink) -> Result<bool>;
    fn cancel_handle(&self) -> CancelHandle;          // Send + Sync, usable while execute runs
    async fn close(self: Box<Self>) -> Result<()>;
}
```
Document and key-value drivers add `DocumentSession` / `KeyValueSession` traits in `add-nosql-browser`; `DriverMeta.family` tells the UI which API to use.

**Why trait objects over an enum:** drivers live in separate modules and can grow independently; the registry is a `HashMap<&'static str, Arc<dyn Driver>>`.

### Paging with server-side cursors
- PostgreSQL: run the statement in a portal (`sqlx` streaming `fetch`) and keep the stream open on the session; `fetch_more` pulls the next N rows. Only one open result stream per session; executing again closes it.
- SQLite: keep the prepared statement stepping on a blocking thread (`spawn_blocking`).
Alternative considered: `LIMIT/OFFSET` re-queries. Rejected: wrong for non-deterministic queries and expensive.

### Streaming to the UI
`query_execute(session_id, sql, opts, channel: Channel<ResultEvent>)`. Events: `Columns`, `Rows(batch)`, `Done(summary)`, `Error(err)`. Rows are sent as `Vec<Vec<Value>>` serialized with serde; batches are capped at 500 rows or 2 MB, whichever comes first.

### Session manager
`SessionManager` (in Tauri state) maps `SessionId → Arc<Mutex<Box<dyn Session>>>` plus a `CancelHandle` stored outside the mutex so cancel never waits on a running execute. Each tab owns one session id. Idle sessions close after 30 min (configurable later).

### Statement splitting
Script mode needs statement boundaries. Use a small dialect-aware splitter in Rust (`drivers/split.rs`) that handles quotes, dollar-quoting (PG), comments and `BEGIN … END` blocks; the frontend uses the same rules through the CodeMirror parser for "current statement". A shared test corpus keeps both in sync.

### SSH
`russh` client; local forward on `127.0.0.1:0`; the tunnel task lives as long as any session or pool for that connection. Known hosts: read `~/.ssh/known_hosts` (read-only) plus `<app_data>/known_hosts` (read-write).

### Errors
`DriverError { code: ErrorCode, message, detail: Option<String>, position: Option<u32>, hint: Option<String> }` where `ErrorCode` covers `auth_failed | timeout | connection_lost | query_failed | cancelled | tls_failed | host_key_mismatch | file_not_found | database_locked | access_denied | driver_unavailable | unsupported`.

### Conformance tests
`src-tauri/tests/conformance/` runs the same scenarios against every driver (behind the `integration` feature, using `docker-compose.yml`); SQLite runs in plain `cargo test`.

## Risks / Trade-offs

- [sqlx streaming holds a borrow on the connection] → the session owns the connection and the stream together in one struct; use `ouroboros`-style ownership or keep the stream in a task that feeds an mpsc channel. Prefer the task + channel approach.
- [Very wide rows exceed the batch byte cap] → batches flush early by size; values over 64 KB are truncated with `truncated: true`.
- [SSH key passphrases] → read from the keychain only; if missing, prompt through a frontend event and never persist without consent.

## Open Questions

- Should the PostgreSQL driver use `tokio-postgres` instead of sqlx for finer control of portals and cancel? Start with sqlx; switch only if portals prove limiting.

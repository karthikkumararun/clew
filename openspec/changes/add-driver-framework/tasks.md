## 1. Contract and registry

- [ ] 1.1 Define `DriverMeta`, `DriverFamily`, `FormKind`, `Capabilities`, `ResolvedConfig` (network/file/uri variants, ssh, tls, timeouts) in `drivers/mod.rs` (spec: driver-framework › Driver registry)
- [ ] 1.2 Define the `Driver` and `Session` traits, `ExecRequest`, `ResultEvent`, `ExecSummary`, `CancelHandle`, `TreeNode`, `NodePath`, `SchemaSnapshot`
- [ ] 1.3 Define `DriverError` + `ErrorCode` and map them to the shell's `AppError` for IPC
- [ ] 1.4 Implement the registry and the `drivers_list` command
- [ ] 1.5 Test: registry lists drivers grouped by family; unknown id gives `driver_unavailable`

## 2. Value model

- [ ] 2.1 Implement `Value` enum with serde tagging and the conversions listed in the spec (spec: driver-framework › Uniform value model)
- [ ] 2.2 Implement truncation (64 KB) with `truncated` flag and a `value_fetch_full` command
- [ ] 2.3 Test: exact decimal round-trip, bigint beyond i64, timestamptz ISO output, `other` fallback

## 3. Sessions and execution

- [ ] 3.1 Implement `SessionManager` (open/close, per-tab sessions, metadata pool of 3, idle close) and commands `session_open`/`session_close` (spec: driver-framework › Sessions)
- [ ] 3.2 Implement `query_execute` streaming over `Channel<ResultEvent>` with 500-row / 2 MB batches and `query_fetch_more` (spec: driver-framework › Execute and stream results)
- [ ] 3.3 Implement the dialect-aware statement splitter (`drivers/split.rs`) with a shared fixture corpus `tests/fixtures/split/*.sql`
- [ ] 3.4 Implement script mode (sequential results, stop on first error unless continue-on-error)
- [ ] 3.5 Implement `query_cancel` and per-connection query timeout (spec: driver-framework › Cancel and timeout)
- [ ] 3.6 Implement lost-connection detection and auto-reconnect on next execute
- [ ] 3.7 Test: splitter corpus; cancel during execute; timeout; reconnect after server kill

## 4. Transport

- [ ] 4.1 Implement TLS config (modes, CA file, client cert/key, OS trust store via rustls-native-certs) (spec: driver-framework › TLS)
- [ ] 4.2 Implement the SSH tunnel with agent / key / password auth and local forward (spec: driver-framework › SSH tunnel)
- [ ] 4.3 Implement host-key verification: read `~/.ssh/known_hosts`, read/write `<app_data>/known_hosts`, emit a `host_key_prompt` event and wait for the user's answer
- [ ] 4.4 Test: tunnel through the docker bastion; host-key mismatch refuses; verify-full hostname mismatch fails

## 5. PostgreSQL driver

- [ ] 5.1 Implement connect/test with server version and timing (spec: driver-framework › Test a connection, PostgreSQL driver)
- [ ] 5.2 Implement the session: execute with streaming portal, fetch_more, cancel via cancel token, error position/hint mapping
- [ ] 5.3 Implement type decoding for all value-model kinds incl. arrays, json/jsonb, uuid, interval, numeric
- [ ] 5.4 Implement introspection queries (databases, schemas, tables with reltuples estimate, views, matviews, functions, sequences, types, columns, PK, FKs, indexes) and the completion snapshot (spec: driver-framework › Lazy schema introspection)
- [ ] 5.5 Report source table/column per result column (via `attrelid`/`attnum` from the row description)
- [ ] 5.6 Test: conformance suite against PostgreSQL 16 in docker-compose

## 6. MySQL and MariaDB driver

- [ ] 6.1 Driver module with flavor, connect/test, sessions, streaming execute, KILL QUERY cancel (spec: driver-framework › MySQL and MariaDB drivers)
- [ ] 6.2 Type mapping incl. zero dates, unsigned bigint, JSON, BIT, ENUM/SET
- [ ] 6.3 Introspection, completion snapshot, SHOW CREATE DDL, session read-only
- [ ] 6.4 Result source table/column metadata and backtick quoting / LIMIT paging for editing (no RETURNING on MySQL → reload by PK)
- [ ] 6.5 Test: conformance suite against mysql:8 and mariadb:11 in docker-compose

## 7. SQLite driver

- [ ] 7.1 Implement open (file path, create-if-missing, busy timeout 5s, read-only flag) (spec: driver-framework › SQLite driver)
- [ ] 7.2 Implement execute/fetch_more on a blocking thread with interrupt-based cancel
- [ ] 7.3 Implement introspection (main + attached, tables, views, indexes, triggers, columns, PK, FKs) and the completion snapshot
- [ ] 7.4 Test: conformance suite against a temp file DB; locked-database scenario

## 8. Frontend IPC layer

- [ ] 8.1 Add typed TS bindings in `src/lib/ipc/drivers.ts` for every command and the `ResultEvent` union (generate types with `ts-rs` or `specta`)
- [ ] 8.2 Add a `useQueryRun()` hook that manages a channel, accumulates batches and exposes fetchMore/cancel
- [ ] 8.3 Test: Vitest with a mocked channel covers batches, done, error and cancel

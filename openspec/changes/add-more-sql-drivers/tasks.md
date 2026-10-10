## 1. Oracle

- [ ] 1.1 Instant Client detection (settings path, ORACLE_HOME, library path, standard folders) and an `oracle_client_status` command for the connection dialog (spec: driver-framework › Oracle driver)
- [ ] 1.2 Driver on the `oracle` crate: connect by service name / SID / TNS alias / Easy Connect, role, wallet; test with server version
- [ ] 1.3 Session on spawn_blocking: streaming fetch, break_execution cancel, OFFSET/FETCH paging, DBMS_OUTPUT capture
- [ ] 1.4 Extend `split.rs` with `/` terminators and PL/SQL block detection (+ fixtures shared with the editor)
- [ ] 1.5 Type mapping (NUMBER, DATE/TIMESTAMP variants, INTERVAL, RAW, CLOB/BLOB truncation, ROWID)
- [ ] 1.6 Introspection (schemas, tables, views, mviews, sequences, synonyms, packages, procedures, functions, columns, constraints, indexes), completion snapshot, DBMS_METADATA DDL
- [ ] 1.7 Read-only via SET TRANSACTION READ ONLY per transaction; editing by PK or ROWID; double-quote identifier quoting
- [ ] 1.8 Connection dialog: Oracle form (connect-by select, service/SID/alias, role, wallet folder) and Instant Client status / setup help per `design/canvas/ConnectionDialog.dc.html`
- [ ] 1.9 Test: conformance suite against Oracle Database 23ai Free (scheduled CI job); missing-client error path

## 2. SQL Server

- [ ] 2.1 tiberius driver: connect (SQL auth; integrated auth on Windows), sessions, streaming, attention cancel (spec: driver-framework › SQL Server driver)
- [ ] 2.2 GO batch splitting in script mode; OFFSET/FETCH paging; bracket quoting
- [ ] 2.3 Type mapping (datetimeoffset, money, uniqueidentifier, varbinary, xml as text)
- [ ] 2.4 Introspection and DDL generation from sys catalog views
- [ ] 2.5 Connection-dialog note that SQL Server has no session read-only
- [ ] 2.6 Test: conformance suite against mssql 2022 (scheduled CI job)

## 3. ClickHouse

- [ ] 3.1 HTTP driver with session_id emulation, RowBinaryWithNamesAndTypes streaming, KILL QUERY cancel (spec: driver-framework › ClickHouse driver)
- [ ] 3.2 Type mapping (Nullable, LowCardinality, Array, Map, Tuple, DateTime64, Decimal)
- [ ] 3.3 Introspection with engine detail; readonly=1 for read-only sessions; editing disabled
- [ ] 3.4 Test: conformance suite (minus editing) against clickhouse-server

## 4. DuckDB

- [ ] 4.1 Bundled DuckDB driver on a blocking thread with interrupt cancel; file and in-memory modes (spec: driver-framework › DuckDB driver)
- [ ] 4.2 Type mapping (HUGEINT, LIST, STRUCT, MAP, INTERVAL, UUID)
- [ ] 4.3 Introspection, READ_ONLY access mode, direct file queries
- [ ] 4.4 Test: conformance suite on a temp file; Parquet query fixture

## 5. CI

- [ ] 5.1 Extend docker-compose and the integration workflow with SQL Server, Oracle and ClickHouse (Oracle and SQL Server on a schedule) and build caching (spec: driver-framework › Conformance across SQL drivers)

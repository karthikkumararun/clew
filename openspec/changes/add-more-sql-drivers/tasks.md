## 1. MySQL and MariaDB

- [ ] 1.1 Driver module with flavor, connect/test, sessions, streaming execute, KILL QUERY cancel (spec: driver-framework › MySQL and MariaDB drivers)
- [ ] 1.2 Type mapping incl. zero dates, unsigned bigint, JSON, BIT, ENUM/SET
- [ ] 1.3 Introspection, completion snapshot, SHOW CREATE DDL, session read-only
- [ ] 1.4 Editing support (backtick quoting, LIMIT paging, no RETURNING on MySQL → reload by PK)
- [ ] 1.5 Test: conformance suite against mysql:8 and mariadb:11

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

- [ ] 5.1 Extend docker-compose and the integration workflow with the new services and build caching (spec: driver-framework › Conformance across SQL drivers)

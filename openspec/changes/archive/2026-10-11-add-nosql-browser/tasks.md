## 1. Contracts and drivers

- [x] 1.1 Define `DocumentSession` / `KeyValueSession` traits and the `Documents` result event (spec: driver-framework › Document session contract, Key-value session contract)
- [x] 1.2 MongoDB driver: URI connect, auth mechanisms, TLS, SSH for non-SRV, server info incl. replica set (spec: driver-framework › MongoDB driver)
- [x] 1.3 BSON ↔ Extended JSON conversion preserving types
- [x] 1.4 Redis driver: connect, ACL/password, TLS, db select, cluster detection (spec: driver-framework › Redis driver)
- [x] 1.5 Explorer introspection for both (databases → collections with counts; db 0–15 → prefix groups)
- [x] 1.6 Test: conformance-style tests against mongo:8 replica set and redis:7

## 2. Document browser

- [x] 2.1 Collection tab: breadcrumb, view switcher, collections side list (spec: document-browser › Collection tab)
- [x] 2.2 Relaxed shell syntax parser in Rust with error positions (spec: document-browser › Query bar)
- [x] 2.3 Query bar (FILTER/PROJECT/SORT/LIMIT, Find Mod+Enter) and toolbar status with index / COLLSCAN
- [x] 2.4 Tree view (Key/Value/Type, carets, summaries, type colors), Table view, JSON view (spec: document-browser › Tree, table and JSON views)
- [x] 2.5 Edit values/fields/whole document, insert, delete, save with version check and safeguards (spec: document-browser › Edit documents)
- [x] 2.6 Inferred schema (sample 1,000) and Indexes view with create/drop (spec: document-browser › Inferred schema and indexes)
- [x] 2.7 Export JSON / JSONL / CSV (spec: document-browser › Export documents)
- [x] 2.8 Test: parser fixtures; edit → update operations; schema inference percentages

## 3. Mongo shell console

- [x] 3.1 Console `mongo` mode: parse `db.<coll>.<method>(...)`, `show collections`, `use <db>`; reject other JS (spec: document-browser › Shell console for MongoDB)
- [x] 3.2 Results in tree/table/JSON views; history recording
- [x] 3.3 Test: supported methods map to driver calls; JS rejection message

## 4. Redis key browser

- [x] 4.1 Key list with incremental SCAN, prefix grouping, pattern filter, db switcher, Load more (spec: key-value-browser › Key list)
- [x] 4.2 Type viewers/editors: string, hash, list, set, zset, stream; TTL, rename, delete; chunked paging (spec: key-value-browser › Key viewer and editor)
- [x] 4.3 Redis console mode with command completion and typed replies; refuse blocking commands (spec: key-value-browser › Redis command console)
- [x] 4.4 Extend safeguard classification for Mongo and Redis writes and dangerous commands
- [x] 4.5 Test: SCAN never calls KEYS; FLUSHDB on production requires typed confirmation

## 5. End-to-end

> Not done in this change: the repository has no `e2e/` framework yet (agreed with the maintainer while applying `add-more-sql-drivers`). Both tasks stay open until it exists; the behaviour is covered by the integration and screen tests above.

- [ ] 5.1 E2E: add journey J-14 in `e2e/specs/` — open a MongoDB collection, filter, edit a field and save; scan Redis keys and edit a hash; production FLUSHDB typed confirmation
- [ ] 5.2 Declare `covers(...)` for the scenarios it exercises (e.g. document-browser › Edit documents; key-value-browser › Key viewer and editor) and add the seed/compose service it needs to the matching profile

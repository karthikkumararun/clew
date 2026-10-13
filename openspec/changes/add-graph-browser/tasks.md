## 1. Driver

- [x] 1.1 Add `graph` family, `GraphSession` trait and value kinds `node`, `relationship`, `path` (spec: driver-framework › Graph session contract)
- [x] 1.2 Neo4j driver on an in-house Bolt client (`neo4rs` stops at Bolt 4.4 and hides the plan, see design.md): schemes, routing, TLS, auth, database selection, server/cluster info (spec: driver-framework › Neo4j driver)
- [x] 1.3 Streaming records with batch size, cancel via RESET, READ/WRITE access modes
- [x] 1.4 Type conversion incl. temporal, duration, point, big integers as strings; dedupe nodes/relationships into `GraphResult`
- [x] 1.5 Introspection: labels/types with counts, property keys, indexes, constraints; completion snapshot; explorer nodes
- [x] 1.6 Add the Neo4j form to the connection dialog (protocol, host, port 7687, user, password, database, AuraDB hint) and `neo4j://` / `neo4j+s://` / `bolt://` / `bolt+s://` URL parsing
- [ ] 1.7 Test: conformance-style tests against `neo4j:5` in docker-compose (records, paging, cancel, read-mode rejection, big ints). Written: `src-tauri/tests/neo4j.rs` (23 tests) and, without Docker, `drivers/neo4j/server_tests.rs` against a fake Bolt server. Tick after a green `docker compose --profile graph up -d --wait && cargo test --features integration --test neo4j`

## 2. Cypher console

- [x] 2.1 Register the graph console tab kind with breadcrumb, Run/Profile, access badge (spec: graph-browser › Graph console tab)
- [x] 2.2 Cypher language support in CodeMirror themed from tokens, with schema-aware completion (spec: graph-browser › Cypher editor)
- [x] 2.3 Parameters panel (JSON) and missing-parameter check
- [x] 2.4 Test: completion offers labels with counts; missing parameter message

## 3. Result views

- [x] 3.1 Graph view on Cytoscape.js + fcose: label colors by stable hash, captions, relationship type labels, legend with counts, zoom/fit controls (spec: graph-browser › Graph view)
- [x] 3.2 Interactions: pan, zoom, drag-to-pin, select, double-click expand neighbours (READ query, limit 25), hide; 300-node cap notice; keyboard-accessible element list
- [x] 3.3 Table, JSON and Plan (EXPLAIN / PROFILE operator tree with db hits) views; auto-switch to Table for scalar results (spec: graph-browser › Table, JSON and Plan views)
- [x] 3.4 Test: GraphResult → Cytoscape elements mapping; cap notice; scalar results open Table

## 4. Sidebar and inspector

- [x] 4.1 Graph schema sidebar (labels, relationship types, property keys, indexes & constraints) with click-to-query that inserts the query first (spec: graph-browser › Graph schema sidebar)
- [x] 4.2 Inspector: chip, element id, typed properties, relationship counts, Expand / Hide / Copy as Cypher MATCH / Edit properties (writable sessions) (spec: graph-browser › Inspector)
- [x] 4.3 Test: label click inserts and runs the label query; property edit generates the parameterised SET

## 5. Safety and integration

- [x] 5.1 Cypher classifier (updating clauses, read-only procedure allow-list, dangerous unfiltered DELETE) wired into the guard (spec: graph-browser › Cypher safeguards)
- [ ] 5.2 Command palette indexing of labels and relationship types; AI assistant `cypher` dialect and graph-schema context (spec: graph-browser › Explorer, palette and AI integration). Backend done: `completion_snapshot` carries `graph` (labels with counts, relationship types, property keys, indexes, constraints, functions, procedures) and the explorer tree lists databases → Node labels / Relationship types / Indexes. Open: the palette index and the AI assistant (`add-ai-assistant` is not built yet; its context builder should read `SchemaSnapshot.graph` and use the `cypher` dialect)
- [ ] 5.3 Test: classifier table (CREATE/MERGE/SET/DELETE/LOAD CSV/CALL); `MATCH (n) DETACH DELETE n` on production requires typed confirmation. Rust side done (`safety/cypher.rs` unit tests; `the_guard_judges_cypher_like_sql` in `src-tauri/tests/neo4j.rs`); the dialog test is left

## 6. End-to-end

- [x] 6.0 E2E: add the test-mode accessible mirror for the graph canvas (`data-testid` nodes and edges, only when `VITE_CLEW_E2E=1`), following `src/features/grid/GridMirror.tsx`
- [ ] 6.1 E2E: add journey J-24 (J-15 is taken by the platform journey) in `e2e/specs/` — run a Cypher query, see the graph, expand neighbours, inspect a node; unfiltered DETACH DELETE on production needs typed confirmation (written in `e2e/specs/J-24-graph-browser.e2e.ts`, needs `pnpm qa:up --profiles graph`; not run yet because Docker Desktop was down)
- [ ] 6.2 Declare `covers(...)` for the scenarios it exercises (e.g. graph-browser › Graph view; graph-browser › Cypher safeguards) and add the seed/compose service it needs to the matching profile (declared in J-24; the neo4j service is in the `graph` profile; tick with 6.1 once the journey has run)

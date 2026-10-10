## 1. Driver

- [ ] 1.1 Add `graph` family, `GraphSession` trait and value kinds `node`, `relationship`, `path` (spec: driver-framework › Graph session contract)
- [ ] 1.2 Neo4j driver on `neo4rs`: schemes, routing, TLS, auth, database selection, server/cluster info (spec: driver-framework › Neo4j driver)
- [ ] 1.3 Streaming records with batch size, cancel via stream drop + RESET, READ/WRITE access modes
- [ ] 1.4 Type conversion incl. temporal, duration, point, big integers as strings; dedupe nodes/relationships into `GraphResult`
- [ ] 1.5 Introspection: labels/types with counts, property keys, indexes, constraints; completion snapshot; explorer nodes
- [ ] 1.6 Add the Neo4j form to the connection dialog (protocol, host, port 7687, user, password, database, AuraDB hint) and `neo4j://` / `neo4j+s://` / `bolt://` / `bolt+s://` URL parsing
- [ ] 1.7 Test: conformance-style tests against `neo4j:5` in docker-compose (records, paging, cancel, read-mode rejection, big ints)

## 2. Cypher console

- [ ] 2.1 Register the graph console tab kind with breadcrumb, Run/Profile, access badge (spec: graph-browser › Graph console tab)
- [ ] 2.2 Cypher language support in CodeMirror themed from tokens, with schema-aware completion (spec: graph-browser › Cypher editor)
- [ ] 2.3 Parameters panel (JSON) and missing-parameter check
- [ ] 2.4 Test: completion offers labels with counts; missing parameter message

## 3. Result views

- [ ] 3.1 Graph view on Cytoscape.js + fcose: label colors by stable hash, captions, relationship type labels, legend with counts, zoom/fit controls (spec: graph-browser › Graph view)
- [ ] 3.2 Interactions: pan, zoom, drag-to-pin, select, double-click expand neighbours (READ query, limit 25), hide; 300-node cap notice; keyboard-accessible element list
- [ ] 3.3 Table, JSON and Plan (EXPLAIN / PROFILE operator tree with db hits) views; auto-switch to Table for scalar results (spec: graph-browser › Table, JSON and Plan views)
- [ ] 3.4 Test: GraphResult → Cytoscape elements mapping; cap notice; scalar results open Table

## 4. Sidebar and inspector

- [ ] 4.1 Graph schema sidebar (labels, relationship types, property keys, indexes & constraints) with click-to-query that inserts the query first (spec: graph-browser › Graph schema sidebar)
- [ ] 4.2 Inspector: chip, element id, typed properties, relationship counts, Expand / Hide / Copy as Cypher MATCH / Edit properties (writable sessions) (spec: graph-browser › Inspector)
- [ ] 4.3 Test: label click inserts and runs the label query; property edit generates the parameterised SET

## 5. Safety and integration

- [ ] 5.1 Cypher classifier (updating clauses, read-only procedure allow-list, dangerous unfiltered DELETE) wired into the guard (spec: graph-browser › Cypher safeguards)
- [ ] 5.2 Command palette indexing of labels and relationship types; AI assistant `cypher` dialect and graph-schema context (spec: graph-browser › Explorer, palette and AI integration)
- [ ] 5.3 Test: classifier table (CREATE/MERGE/SET/DELETE/LOAD CSV/CALL); `MATCH (n) DETACH DELETE n` on production requires typed confirmation

## Why

Graph databases answer questions about relationships that SQL and documents make painful: who bought what, what depends on what, how things connect. Neo4j is the most widely used graph database, and its data reads best as an actual graph, so Clew needs a Cypher console with a graph view next to tables and documents.

## What Changes

- Add a `graph` driver family and a Neo4j driver (Neo4j 4.4 LTS and 5.x, including AuraDB) over the Bolt protocol with `neo4j://`, `neo4j+s://`, `bolt://` and `bolt+s://` schemes, multiple databases and cluster routing.
- Add the graph browser tab from `design/canvas/GraphBrowser.dc.html`: a Cypher editor (highlighting, schema-aware completion, parameters), result views Graph / Table / JSON / Plan, a graph schema sidebar (node labels with counts, relationship types, property keys, indexes and constraints), a node/relationship inspector, expand neighbours, hide, legend and zoom controls.
- Add the Neo4j form to the connection dialog (`design/canvas/ConnectionDialog.dc.html`: protocol, host, port 7687, user, password, database).
- Apply production safeguards to Cypher: read sessions use Neo4j's READ access mode; writes (CREATE, MERGE, SET, DELETE, REMOVE, DETACH DELETE, LOAD CSV, schema commands) need confirmation; `MATCH (n) DETACH DELETE n` without a filter is a dangerous statement.
- Explorer, command palette and AI assistant integration: labels and relationship types appear in the explorer and palette; the AI assistant uses the Cypher dialect and the graph schema as context.

## Capabilities

### New Capabilities
- `graph-browser`: the Cypher console, graph/table/JSON/plan result views, schema sidebar, inspector and graph interactions.

### Modified Capabilities
- `driver-framework`: adds the graph session contract and the Neo4j driver (new requirements only).

## Impact

- Rust: `src-tauri/src/drivers/neo4j/` on the `neo4rs` crate; `GraphSession` trait; value model gains `node`, `relationship` and `path` kinds plus Neo4j temporal and spatial types.
- Frontend: `src/features/graph/` (GraphView on Cytoscape.js, Inspector, SchemaSidebar), Cypher language support for CodeMirror 6.
- docker-compose: `neo4j:5` (community) for integration tests.
- Depends on `add-sql-console` (console tab and results panel), `add-production-safeguards`; best after `add-nosql-browser`.

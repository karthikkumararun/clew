## Context

Canvas: `design/canvas/GraphBrowser.dc.html` (schema sidebar, Cypher editor, Graph/Table/JSON/Plan views, graph with label colors and relationship captions, legend, zoom controls, inspector) and the Neo4j form in `design/canvas/ConnectionDialog.dc.html`. The console, results panel, safeguards and AI context builder already exist from earlier changes.

## Goals / Non-Goals

**Goals:** Neo4j Browser-level exploration inside Clew; graph rendering that stays smooth to a few thousand elements; the same safety model as SQL.
**Non-Goals:** other graph databases (Memgraph via Bolt may work but isn't tested; Neptune/ArangoDB not planned), Graph Data Science procedures UI, styling editor (GraSS) beyond caption property and label colors, Bloom-style perspectives.

## Decisions

### Driver
`neo4rs` (async Rust Bolt driver, MIT): supports Bolt 4.x/5.x, routing (`neo4j://`), TLS schemes, and streaming via `RowStream`. Records are converted to the value model with new kinds `node`, `relationship`, `path`; integers stay i64 (and are sent to JS as strings when outside ±2^53). Cancel drops the stream and sends RESET on the connection. Introspection uses `CALL db.labels()`, `db.relationshipTypes()`, `db.propertyKeys()`, `SHOW INDEXES`, `SHOW CONSTRAINTS`, and counts via `MATCH (n:Label) RETURN count(n)` from the count store (cheap). Read-only sessions open transactions with access mode READ.
Alternative considered: HTTP Query API. Rejected: no streaming of large results and no routing.

### Cypher editor
Neo4j publishes open-source (Apache-2.0) Cypher language support for CodeMirror 6 (the `@neo4j-cypher/*` packages: language support, highlighting, schema-aware completion). Use it, feeding it Clew's schema snapshot and theming it from tokens; verify current package names at implementation time. Fallback: a CM6 StreamLanguage with a keyword list plus Clew's own completion source.

### Graph rendering
Cytoscape.js (MIT) with the `fcose` layout extension: canvas rendering, handles thousands of elements, built-in pan/zoom/selection/drag, and a stylesheet API we drive from tokens. Label colors come from a fixed 10-color list derived from token hues, assigned by a stable hash of the label name so the same label always gets the same color across sessions. Captions: user-selectable property per label, stored in `ui_state`. Accessibility: a hidden, focusable list mirrors the graph elements for keyboard and screen readers.
Alternative considered: d3-force + custom canvas (more work for hit-testing and interactions); vis-network (heavier, less active).

### Results model
`GraphResult { records, nodes: Map<ElementId, Node>, relationships: Map<ElementId, Rel> }` built in Rust while streaming so the frontend gets de-duplicated elements. Expand neighbours runs `MATCH (n)-[r]-(m) WHERE elementId(n) = $id RETURN r, m LIMIT 25` in a READ transaction.

### Safeguards
`safety/classify.rs` gains a Cypher classifier using a lightweight tokenizer (no full Cypher grammar in Rust): it looks for updating clauses outside strings/comments, and maintains an allow-list of read-only procedures (`db.labels`, `db.relationshipTypes`, `db.propertyKeys`, `db.schema.*`, `dbms.components`, `SHOW …`).

## Risks / Trade-offs

- [`neo4rs` coverage of newest Bolt features] → Pin a version tested against Neo4j 4.4, 5.x and AuraDB in CI; fall back gracefully on unknown types (value kind `other`).
- [Graph layouts on large results are slow] → Cap at 300 nodes by default, run layout in a Web Worker where the extension allows, and offer Table view.
- [Cypher tokenizer misclassifies exotic queries] → Unknown/ambiguous → treated as write; READ access mode is the backstop on read-only sessions.

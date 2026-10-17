## ADDED Requirements

### Requirement: Graph session contract
Drivers of the `graph` family SHALL provide: list databases, run a query with parameters in a READ or WRITE transaction with streaming records, cancel, explain/profile, and schema introspection (node labels with counts, relationship types with counts, property keys, indexes, constraints). The value model SHALL include `node` (element id, labels, properties), `relationship` (element id, type, start and end node ids, properties) and `path` (alternating nodes and relationships).

#### Scenario: Records with graph values
- **WHEN** a query returns `u, p, other`
- **THEN** each record carries three `node` values with their labels and properties, and the result exposes the distinct nodes and relationships for graph rendering

#### Scenario: Paging records
- **WHEN** a query returns 50,000 records with a fetch size of 500
- **THEN** records stream in batches and the result reports `has_more` until the stream ends

### Requirement: Neo4j driver
The system SHALL include a Neo4j driver for Neo4j 4.4 and 5.x (including AuraDB) over Bolt, with schemes `neo4j://`, `neo4j+s://`, `bolt://` and `bolt+s://`, default port 7687, basic auth, database selection (default `neo4j`), cluster routing for `neo4j://` schemes, and conversion of Neo4j types (Integer, Float, String, Boolean, List, Map, Date, Time, LocalTime, DateTime, LocalDateTime, Duration, Point, Node, Relationship, Path, bytes) to the value model.

#### Scenario: Server version in status
- **WHEN** a Neo4j session opens on a 3-member cluster
- **THEN** the status bar shows "Neo4j <version> · cluster (3 members)"

#### Scenario: Large integers
- **WHEN** a property holds the integer 9007199254740993 (beyond JavaScript's safe range)
- **THEN** the value arrives as an exact integer string and is not rounded

#### Scenario: Read-only access mode
- **WHEN** a session is read-only and the user runs `CREATE (n:Test)`
- **THEN** Clew's guard blocks it, and if it reached the server inside a READ transaction the server would reject it too

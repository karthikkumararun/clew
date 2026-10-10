## ADDED Requirements

### Requirement: Document session contract
Drivers of the `document` family SHALL provide: list databases, list collections (with estimated document counts), find (filter, projection, sort, skip, limit) with streaming cursors, aggregate, count, insert, replace, update and delete by `_id`, list/create/drop indexes, and schema inference by sampling.

#### Scenario: Cursor paging
- **WHEN** a find matches 1,936 documents with a page size of 50
- **THEN** the first 50 arrive with `has_more = true`, and fetching more continues the same cursor

### Requirement: Key-value session contract
Drivers of the `keyvalue` family SHALL provide: select logical database, SCAN by pattern with type and TTL (incremental, never `KEYS *`), get/set values per type, set/remove TTL, rename, delete, and execute a raw command returning a typed reply.

#### Scenario: Large keyspace
- **WHEN** a Redis database holds 5 million keys and the user scans `session:*`
- **THEN** results stream in SCAN batches of ~1,000 and the server is never asked for `KEYS`

### Requirement: MongoDB driver
The system SHALL include a MongoDB (5.0+) driver connecting with a `mongodb://` or `mongodb+srv://` URI, auth database and mechanism (SCRAM-SHA-256, X.509, none), TLS and optional SSH tunnel (for non-SRV URIs), converting BSON to Extended JSON (relaxed) for display with types preserved (ObjectId, Date, Decimal128, Int32/Int64, Double, Binary, Timestamp, Regex, MinKey/MaxKey).

#### Scenario: ObjectId display
- **WHEN** a document has `_id: ObjectId("6703f1c2a9e41d7c2e0fb812")`
- **THEN** the value shows as `ObjectId("6703f1c2a9e41d7c2e0fb812")` with type ObjectId, and editing preserves it as an ObjectId

#### Scenario: Server version in status
- **WHEN** a MongoDB session opens on a replica set
- **THEN** the status bar shows "MongoDB <version> · replica set <name>"

### Requirement: Redis driver
The system SHALL include a Redis (6+) driver with host, port, database index, username/password (ACL) or password, TLS (`rediss://`), and support for standalone servers; cluster mode SHALL be detected and reported as unsupported in v1.

#### Scenario: Cluster detected
- **WHEN** the server reports `cluster_enabled:1`
- **THEN** the connection test fails with "Redis Cluster isn't supported yet"

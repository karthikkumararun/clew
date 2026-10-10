## Why

Clew promises SQL and NoSQL in one window. MongoDB and Redis are the two NoSQL stores a typical programmer touches every week, and they need browsing tools shaped to their data: documents as trees, keys by pattern and type.

## What Changes

- Add MongoDB and Redis drivers implementing the driver contract plus family-specific session traits (`DocumentSession`, `KeyValueSession`).
- Add the document browser tab from `design/canvas/MongoBrowser.dc.html`: collections list, FILTER / PROJECT / SORT / LIMIT query bar, Tree / Table / JSON views, inferred schema, indexes, insert/edit/delete documents, export JSON.
- Add a Mongo shell-style console (`db.collection.find(...)`, `aggregate`, `countDocuments`, `insertOne`…) using the same console tab with a JavaScript-like mode.
- Add the Redis key browser: SCAN by pattern with type and TTL, viewers/editors per type (string, hash, list, set, sorted set, stream), and a Redis command console.
- Explorer integration: MongoDB databases → collections; Redis databases (0–15) → key patterns grouped by prefix.

Canvas screens implemented: `design/canvas/MongoBrowser.dc.html` (including the CACHE-REDIS · KEYS list).

## Capabilities

### New Capabilities
- `document-browser`: browsing, querying and editing MongoDB collections and documents.
- `key-value-browser`: browsing and editing Redis keys and running Redis commands.

### Modified Capabilities
- `driver-framework`: adds the MongoDB and Redis drivers and the document / key-value session contracts (new requirements only).

## Impact

- Rust: `drivers/mongodb/`, `drivers/redis/`, `DocumentSession` / `KeyValueSession` traits; Extended JSON (EJSON) conversion for BSON types.
- Frontend: `src/features/documents/`, `src/features/keys/`; the console gains a `mongo` and a `redis` mode.
- Dependencies: `mongodb`, `bson`, `redis` (with tokio + TLS features). docker-compose: mongo:8 (replica set), redis:7.

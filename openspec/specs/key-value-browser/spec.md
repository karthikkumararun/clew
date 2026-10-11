# key-value-browser Specification

## Purpose
TBD - created by archiving change add-nosql-browser. Update Purpose after archive.
## Requirements

### Requirement: Key list
For a Redis connection, the explorer and the browser side list SHALL show keys from an incremental SCAN, grouped by prefix (split on `:`), each with its type; the user SHALL be able to filter by glob pattern (e.g. `session:*`) and switch logical database (0–15).

#### Scenario: Group by prefix
- **WHEN** keys `session:1`, `session:2` and `rate:ip:1.2.3.4` exist
- **THEN** the list shows groups `session:*` (2) and `rate:*` with their types

#### Scenario: Keep scanning
- **WHEN** the first SCAN batch is shown and more keys remain
- **THEN** a "Load more" row continues the cursor

### Requirement: Key viewer and editor
Opening a key SHALL show a viewer for its type with TTL, size and encoding: string (text / JSON pretty-print / hex), hash (field/value grid), list (index/value), set (members), sorted set (member/score, sorted), stream (entry id + fields, latest first). The user SHALL be able to edit values, add/remove members or fields, set or clear TTL, rename and delete keys (safeguards apply).

#### Scenario: Edit a hash field
- **WHEN** the user changes field `plan` of `session:42` to `pro` and saves
- **THEN** `HSET session:42 plan pro` runs and the viewer refreshes

#### Scenario: Large collection
- **WHEN** a list has 2 million elements
- **THEN** the viewer pages through it with LRANGE in chunks of 500

### Requirement: Redis command console
A console tab on a Redis connection SHALL accept Redis commands one per line with completion of command names and arguments, show typed replies (string, integer, array as a list, nil, error), and refuse blocking commands (`MONITOR`, `SUBSCRIBE`, `BLPOP` with no timeout) with an explanation.

#### Scenario: Run a command
- **WHEN** the user runs `HGETALL session:42`
- **THEN** the reply shows as a field/value table

#### Scenario: Dangerous command on production
- **WHEN** the user runs `FLUSHDB` on a production Redis connection
- **THEN** the type-the-connection-name confirmation from `production-safeguards` is required

-- Objects of every connection the command palette can jump to. Rebuilt per (connection, database)
-- from the completion snapshot, so objects of disconnected connections stay searchable.
CREATE TABLE palette_index (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT    NOT NULL,
    database      TEXT    NOT NULL DEFAULT '',
    kind          TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    -- Where it lives, shown beside the name (e.g. `analytics.public`).
    parent_label  TEXT    NOT NULL DEFAULT '',
    -- JSON array of path segments that opens the table (or the owning table of a column).
    path          TEXT    NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX palette_index_by_connection ON palette_index (connection_id, database);

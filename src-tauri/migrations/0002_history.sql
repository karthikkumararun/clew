-- Statements executed from consoles, newest first per connection (kept local, never sent anywhere).
CREATE TABLE history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT    NOT NULL,
    database      TEXT    NOT NULL DEFAULT '',
    sql           TEXT    NOT NULL,
    started_at    INTEGER NOT NULL,
    duration_ms   INTEGER NOT NULL,
    rows          INTEGER,
    outcome       TEXT    NOT NULL CHECK (outcome IN ('ok', 'error', 'cancelled'))
);
CREATE INDEX history_by_connection ON history (connection_id, started_at DESC);

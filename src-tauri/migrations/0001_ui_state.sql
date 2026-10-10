-- Key/value UI state: pane sizes, open flags, the persisted tab session.
CREATE TABLE ui_state (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

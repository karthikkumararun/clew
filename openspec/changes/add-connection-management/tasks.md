## 1. Model and storage (Rust)

- [ ] 1.1 Define the connection model, groups and environment enum with serde (`connections/model.rs`) (spec: connection-management › Connection model)
- [ ] 1.2 Implement `store.rs`: load, atomic save, mtime-guarded merge-by-id, schema version (spec: connection-management › Persist connections without secrets)
- [ ] 1.3 Implement `secrets.rs` on `keyring` with redacted `Debug` and the keychain-unavailable fallback
- [ ] 1.4 Implement `resolve(id) -> ResolvedConfig` (fills secrets; asks the frontend for "ask every time" passwords via an event)
- [ ] 1.5 Commands: `connections_list`, `connections_save`, `connections_delete`, `connections_duplicate`, `groups_save`, `groups_delete`
- [ ] 1.6 Test: no secret ever appears in `connections.json`; concurrent edit merge; production defaults

## 2. URL parsing

- [ ] 2.1 Implement `url.rs` parse + build for every scheme in the spec (spec: connection-management › Paste a connection URL)
- [ ] 2.2 Command `connections_parse_url`
- [ ] 2.3 Test: table-driven parse/build round-trips; unknown scheme error

## 3. Connection dialog (frontend)

- [ ] 3.1 Build the dialog shell, driver list with search and SQL/NoSQL groups per `ConnectionDialog.dc.html` (spec: connection-management › Connection dialog)
- [ ] 3.2 Build Name (with suggestion), Group select, Environment chips
- [ ] 3.3 Build General forms: NetworkForm, FileForm, UriForm, KeyValueForm; port follows driver default until edited
- [ ] 3.4 Build the SSH tunnel, SSL / TLS and Advanced tabs
- [ ] 3.5 Build the URL preview with Copy and the Production safeguards box
- [ ] 3.6 Validation, Esc / Mod+Enter, focus order
- [ ] 3.7 Test connection inline result, error details toggle, cancel after 2s (spec: connection-management › Test connection from the dialog)
- [ ] 3.8 Test: Vitest for driver switch port behaviour, name suggestion, validation and the safeguards box

## 4. Organise, connect and the chip

- [ ] 4.1 Rename, duplicate (copies secrets), delete with confirmation (removes secrets, closes tabs), move between groups (spec: connection-management › Organise connections)
- [ ] 4.2 Commands `connections_connect` / `connections_disconnect`; disconnect asks about open transactions (spec: connection-management › Connect and disconnect)
- [ ] 4.3 Toolbar connection chip with database/schema switcher (spec: connection-management › Toolbar connection chip)
- [ ] 4.4 Status bar connection item (dot, name, server version, "via SSH <host>")
- [ ] 4.5 Test: delete removes secrets; schema switch issues the right statement

## 5. Welcome wiring

- [ ] 5.1 Recent list (5 most recent, relative time, short address) and open-on-click (spec: connection-management › Recent connections)
- [ ] 5.2 Wire `connection.new`, `connection.fromUrl`, `file.openDatabase` (opens SQLite/DuckDB file picker → prefilled dialog) commands
- [ ] 5.3 Test: recent ordering and click-to-connect with a mocked IPC

## 6. Import and export

- [ ] 6.1 Implement importers: DataGrip, DBeaver, pgpass, Clew JSON with fixtures (spec: connection-management › Import connections)
- [ ] 6.2 Build the import preview dialog (checkboxes, duplicate flag, unsupported-driver rows disabled, "Import passwords" for pgpass)
- [ ] 6.3 Implement export of selected connections without secrets (spec: connection-management › Export connections)
- [ ] 6.4 Update the Welcome copy to list only the importers that exist
- [ ] 6.5 Test: importer fixtures; export contains no secrets

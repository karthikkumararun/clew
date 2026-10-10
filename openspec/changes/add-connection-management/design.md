## Context

`add-driver-framework` gives us drivers that accept a `ResolvedConfig` (with secrets filled in). This change owns everything about *saved* connections: storage, secrets, the dialog and imports. UI source: `design/canvas/ConnectionDialog.dc.html` (interactive; its script shows the per-driver form switching and default ports), `design/canvas/Welcome.dc.html`.

## Goals / Non-Goals

**Goals:** safe secret storage, a dialog that adapts to every driver kind, painless import.
**Non-Goals:** syncing connections between machines; team-shared connection files with secrets; Oracle or other drivers not in the registry.

## Decisions

### Storage format
`<app_data>/connections.json`:
```json
{ "version": 1,
  "groups": [{ "id": "g1", "name": "Production", "order": 0 }],
  "connections": [{ "id": "c_01H…", "name": "prod-postgres", "driver": "postgres", "groupId": "g1",
    "environment": "production", "settings": { "kind": "network", "host": "db.internal", "port": 5432,
    "database": "analytics", "user": "karthik", "passwordMode": "keychain" },
    "ssh": { "enabled": true, "host": "bastion.example.net", "port": 22, "user": "karthik", "auth": "agent" },
    "tls": { "mode": "verify-full", "caFile": "~/certs/ca.pem" },
    "advanced": { "connectTimeoutSec": 10, "queryTimeoutSec": 0, "keepAliveSec": 60, "onConnect": ["SET …"], "properties": { "application_name": "clew" } },
    "safeguards": { "readOnlyByDefault": true, "confirmWrites": true, "manualCommit": true },
    "lastUsedAt": "2026-10-09T10:42:07Z" }] }
```
Writes are atomic (write temp + rename) and guarded by an mtime check with merge-by-id. Ids are ULIDs. A `version` field allows migrations.

### Secrets
`keyring` crate; service `Clew`, account `<id>:password`, `<id>:ssh-passphrase`, `<id>:ssh-password`. `secrets.rs` is the only module that touches the keychain. Resolving a connection (`resolve(id) -> ResolvedConfig`) pulls secrets in memory; `ResolvedConfig` implements `Debug` with secrets redacted.

### Dialog architecture
`ConnectionDialog` holds a draft in local state (Zustand slice per dialog). `DriverMeta.formKind` picks the General form: `NetworkForm`, `FileForm`, `UriForm` (MongoDB), `KeyValueForm` (Redis). Port follows the driver default until the field is "dirty". URL preview is built by a shared `buildUrl(draft)` mirrored from Rust `url.rs` tests (password always omitted).

### Imports
`import/` has one module per source returning `Vec<ImportCandidate>`; the preview dialog shows them. DataGrip: parse `dataSources.xml` `<data-source>` → `driver-ref` + `jdbc-url` (map JDBC URL schemes to Clew drivers). DBeaver: `data-sources.json` `connections.*.configuration`. pgpass: one candidate per non-wildcard line (password goes to keychain only if the user ticks "Import passwords").

### Toolbar chip and switching database/schema
The chip reads the active tab's `{connectionId, database, schema}`. Switching database opens a new session for the tab (Postgres needs a new connection per database); switching schema runs `SET search_path` (PG) / `USE` (MySQL).

## Risks / Trade-offs

- [Keychain prompts on macOS for unsigned dev builds] → Expected during development; signed builds keep a stable identity.
- [Windows Credential Manager 2.5 KB limit per secret] → Passwords fit; reject anything larger with a clear message.
- [DataGrip/DBeaver formats change] → Importers are best-effort with fixtures from current versions; failures show which entries were skipped.

## Open Questions

- TablePlus import: its connection file is not a documented format. The Welcome copy currently mentions TablePlus; drop it from the copy unless an importer lands.

## Context

`add-driver-framework` gives us drivers that accept a `ResolvedConfig` (with secrets filled in). This change owns everything about *saved* connections: storage, secrets, the dialog and imports. UI source: `design/canvas/ConnectionDialog.dc.html` (interactive; its script shows the per-driver form switching and default ports), `design/canvas/Welcome.dc.html`.

## Goals / Non-Goals

**Goals:** safe secret storage, a dialog that adapts to every driver kind, painless import.
**Non-Goals:** live syncing connections between machines (export/import is the manual path); Oracle or other drivers not in the registry.

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
`ConnectionDialog` holds a draft in local state (Zustand slice per dialog). `DriverMeta.formKind` picks the General form: `NetworkForm`, `OracleForm`, `FileForm`, `UriForm` (MongoDB), `KeyValueForm` (Redis). Port follows the driver default until the field is "dirty". URL preview is built by a shared `buildUrl(draft)` mirrored from Rust `url.rs` tests (password always omitted).

### Export file format (`.clew`)
```json
{ "format": "clew-connections", "version": 1, "createdAt": "2026-10-10T09:00:00Z",
  "app": "Clew 0.1.0", "counts": { "connections": 3, "passwords": 3, "sshKeys": 1, "sqlFiles": 9 },
  "encryption": { "cipher": "AES-256-GCM", "kdf": "argon2id", "salt": "<b64 16B>", "m": 65536, "t": 3, "p": 1, "nonce": "<b64 12B>" },
  "payload": "<b64 ciphertext+tag>" }
```
- The header is authenticated as AES-GCM associated data, so editing it breaks decryption.
- `payload` decrypts to `{ groups, connections, secrets: { "<connId>:password": "…" }, sshKeys: [{ id, fileName, pem }], sqlFiles: [{ connId, relPath, content }] }`.
- Without secrets, `encryption` is absent and `payload` is the plain object (file extension `.json`).
- Crates: `argon2`, `aes-gcm`, `rand` (OsRng), `zeroize` for passphrase and key buffers. The passphrase is collected in the WebView and sent once over IPC to the export/import command; it is never logged or persisted, and Rust zeroizes it after deriving the key.
- SSH keys are imported to `<app_data>/ssh-keys/<connId>_<fileName>`; on macOS `chmod 600`, on Windows an ACL granting only the current user. They are files, not keychain items, because RSA-4096 keys exceed Windows Credential Manager's 2.5 KB limit.

### Imports
`import/` has one module per source returning `Vec<ImportCandidate { connection, secrets?, sqlFiles[], status }>`; the review list shows them and nothing is written until Import.
- **DataGrip:** discover `DataGrip*` config folders (macOS `~/Library/Application Support/JetBrains/`, Windows `%APPDATA%\JetBrains\`), newest version first; parse `options/dataSources.xml` (+ `.local.xml`) and project `.idea/dataSources.xml` (+ `.local.xml`) with `quick-xml`: `<data-source name uuid>`, `<driver-ref>`, `<jdbc-url>`, `<user-name>` (local file), SSH (`<ssh-properties>`), SSL. Map JDBC URLs to Clew drivers: postgresql, mysql, mariadb, sqlserver, oracle:thin (`/service` vs `:SID`), sqlite, clickhouse, duckdb, mongodb, redis, neo4j. Consoles: `consoles/db/<uuid>/*.sql`; scratches: `scratches/*.sql`.
- **DataGrip passwords (macOS only):** DataGrip stores them as generic keychain items whose service names include the data source's uuid (verify the exact naming against current DataGrip during implementation); read them with `security-framework`, which triggers the macOS access prompt. Windows (KeePass store) is out of scope for v1.
- **DBeaver:** `data-sources.json` `connections.*.configuration` (passwords are encrypted with a well-known key in `credentials-config.json`; we deliberately don't decrypt them).
- **pgpass:** one candidate per non-wildcard line.
- **Environment detection:** regex on the name: `prod|prd` → production, `stag|stg|uat` → staging, `dev|test` → development, else local.

### Scripts folders
`connections.json` stores `scriptsDir` per connection (default `~/Documents/Clew/Scripts/<name>/`) and the app store keeps `file → connectionId` links, so files moved by the user can be re-linked from the console's connection chip.

### Toolbar chip and switching database/schema
The chip reads the active tab's `{connectionId, database, schema}`. Switching database opens a new session for the tab (Postgres needs a new connection per database); switching schema runs `SET search_path` (PG) / `USE` (MySQL).

## Risks / Trade-offs

- [Keychain prompts on macOS for unsigned dev builds] → Expected during development; signed builds keep a stable identity.
- [Windows Credential Manager 2.5 KB limit per secret] → Passwords fit; reject anything larger with a clear message.
- [DataGrip/DBeaver formats change] → Importers are best-effort with fixtures from current versions; failures show which entries were skipped.

## Open Questions

- TablePlus import: not planned (undocumented format); the Welcome copy no longer mentions it.
- DataGrip keychain item naming must be confirmed against the current DataGrip release before implementing password import.

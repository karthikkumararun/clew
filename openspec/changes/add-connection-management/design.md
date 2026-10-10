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
- **DataGrip passwords:** per JetBrains' Password Safe docs (https://www.jetbrains.com/help/datagrip/reference-ide-settings-password-safe.html), DataGrip has no store of its own: it uses "In native Keychain" (macOS Keychain Access; Linux GNOME Keyring/KWallet; not offered on Windows), "In KeePass" (a `c.kdbx` database unlocked by a master password, optionally PGP-protected; location configurable) or "Do not save". Read DataGrip's choice and KeePass path from its `options/security.xml`.
  - Native keychain (macOS): read the generic items for each data source with `security-framework`; macOS prompts per item.
  - KeePass: open `c.kdbx` read-only with the `keepass` crate. The master key comes from DataGrip's stored master-password file when it is protected for the current OS user (Windows DPAPI via `windows` crate `CryptUnprotectData`; macOS keychain) — otherwise prompt the user for the master password, use it once and zeroize it. PGP-protected master passwords: prompt the user instead of decrypting the PGP envelope.
  - URL-only data sources keep credentials inside the JDBC URL in plain text; extract the password into Clew's keychain and drop it from the stored URL.
  - Entry naming (keychain service / KeePass entry titles and how they reference the data source uuid) and the master-password file name/format are not documented; confirm them against a current DataGrip install and keep parsing tolerant.
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
- DataGrip keychain item / KeePass entry naming and the stored master-password file format are undocumented; confirm them against a current DataGrip install (macOS and Windows) before implementing task 7.4.

### Decisions made during implementation
- **Pasted URL password:** `connections_parse_url` returns the password found in the URL so the dialog can show it in the Password field (spec: "Postgres URL with password"). It is the one secret that travels to the WebView, and only because the user pasted it moments earlier; nothing else ever returns a secret.
- **Test connection:** `connections_test(request, testId)` resolves the unsaved draft in Rust (typed secrets win over stored ones, never prompts, saves nothing); `connections_test_cancel(testId)` aborts it.
- **Driver list:** the dialog shows all eleven drivers from a static catalog and disables those missing from `drivers_list` ("soon") until their changes land.
- **File picker:** `tauri-plugin-dialog` with only `dialog:allow-open` / `dialog:allow-save`; no fs plugin is registered.

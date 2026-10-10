## Why

A database IDE is only as useful as the connections it remembers. Users need to create, test, organise and reuse connections to many databases across environments, with passwords kept safely, and get them in quickly from tools they already use.

## What Changes

- Add a connection model: name, driver, group, environment (local / development / staging / production), driver-specific settings, SSH, TLS, advanced options and safeguard flags.
- Persist connections to `connections.json` in the app-data dir with **no secrets**; passwords and passphrases live in the OS keychain (macOS Keychain, Windows Credential Manager).
- Add the New / Edit connection dialog from `design/canvas/ConnectionDialog.dc.html`: driver list with search, Name/Group, Environment chips, General / SSH tunnel / SSL / Advanced tabs, driver-specific forms (network, file, MongoDB URI, Redis), live URL preview, Test connection, Save & connect.
- Add "paste a connection URL" parsing (Welcome screen and dialog).
- Add import from DataGrip, DBeaver, `~/.pgpass` and Clew's own JSON export; export connections without secrets.
- Add connect/disconnect, duplicate, rename, delete, move between groups, and the toolbar connection chip.
- Wire the Welcome screen's Recent list and actions.

Canvas screens implemented: `design/canvas/ConnectionDialog.dc.html`, the Recent/actions parts of `design/canvas/Welcome.dc.html`, the connection chip in `design/canvas/Main.dc.html`.

## Capabilities

### New Capabilities
- `connection-management`: connection model and storage, secrets, the connection dialog, URL parsing, import/export, recent connections and connect/disconnect.

### Modified Capabilities
- (none)

## Impact

- Rust: `src-tauri/src/connections/{model.rs,store.rs,secrets.rs,url.rs,import/}`; commands `connections_list/save/delete/duplicate/connect/disconnect/test/parse_url/import/export`.
- Frontend: `src/features/connections/` (dialog, forms per kind, environment picker, connection chip, recent list).
- Dependencies: `keyring`, `quick-xml` (DataGrip import), `url`.

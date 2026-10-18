## 1. Store and migration

- [x] 1.1 Storage in the existing `ui_state` store (no Rust table: see design notes) with the 5 MB cap of session restore (spec: workspaces › Workspace model)
- [x] 1.2 The saved tab list is the Last session (it keeps its storage key) (spec: workspaces › Migration)
- [x] 1.3 Test: migration keeps tabs and text; secrets and results are never in the stored JSON

## 2. Frontend model

- [x] 2.1 Make `workspaceStore` operate on the active workspace; debounced auto-save, save on switch and quit (spec: workspaces › Default workspace per connection)
- [x] 2.2 Per-connection default workspaces updated from that connection's consoles
- [x] 2.3 Derived environment per workspace (spec: workspaces › Environment grouping)
- [x] 2.4 Test: auto-save timing, default workspace updates, derived environment including a changed connection environment

## 3. Switching and restore

- [x] 3.1 Switch flow reusing the unsaved-file and open-transaction prompts; cancel leaves everything unchanged (spec: workspaces › Switching workspaces)
- [x] 3.2 Passive restore: no SQL, no connections, production read-only, deleted connection notice with Bind to connection… (spec: workspaces › Safe restore)
- [x] 3.3 Restore the active workspace on launch (spec: app-shell › Persisted workspace state)
- [x] 3.4 Test: scenarios above, including "restore does not run anything"

## 4. UI

- [x] 4.1 Toolbar workspace switcher with environment groups and stripe, Save as…, rename, duplicate, delete (spec: workspaces › Managing workspaces)
- [x] 4.2 Explorer: Open workspace on a connection
- [x] 4.3 Command palette actions: Switch workspace, Save workspace as…; shortcut through the registry
- [x] 4.4 Match design tokens (switcher checked on a screenshot; no canvas exists for the design-states suite yet)
- [x] 4.5 Test: switcher rendering, keyboard operation, delete-active confirmation

## 5. End-to-end

- [x] 5.1 E2E journey: create two workspaces on two connections, switch, quit and relaunch, text restored, nothing executed; declare `covers(...)` for the workspaces scenarios

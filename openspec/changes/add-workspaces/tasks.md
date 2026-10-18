## 1. Store and migration

- [ ] 1.1 `workspaces` table and Rust commands (list, save, load, rename, duplicate, delete) with a 5 MB cap (spec: workspaces › Workspace model)
- [ ] 1.2 Migrate the saved tab list to the `last_session` workspace on first launch (spec: workspaces › Migration)
- [ ] 1.3 Test: migration keeps tabs and text; secrets and results are never in the stored JSON

## 2. Frontend model

- [ ] 2.1 Make `workspaceStore` operate on the active workspace; debounced auto-save, save on switch and quit (spec: workspaces › Default workspace per connection)
- [ ] 2.2 Per-connection default workspaces updated from that connection's consoles
- [ ] 2.3 Derived environment per workspace (spec: workspaces › Environment grouping)
- [ ] 2.4 Test: auto-save timing, default workspace updates, derived environment including a changed connection environment

## 3. Switching and restore

- [ ] 3.1 Switch flow reusing the unsaved-file and open-transaction prompts; cancel leaves everything unchanged (spec: workspaces › Switching workspaces)
- [ ] 3.2 Passive restore: no SQL, no connections, production read-only, deleted connection notice with Bind to connection… (spec: workspaces › Safe restore)
- [ ] 3.3 Restore the active workspace on launch (spec: app-shell › Persisted workspace state)
- [ ] 3.4 Test: scenarios above, including "restore does not run anything"

## 4. UI

- [ ] 4.1 Toolbar workspace switcher with environment groups and stripe, Save as…, rename, duplicate, delete (spec: workspaces › Managing workspaces)
- [ ] 4.2 Explorer: Open workspace on a connection
- [ ] 4.3 Command palette actions: Switch workspace, Save workspace as…; shortcut through the registry
- [ ] 4.4 Match design tokens; add the switcher and dialogs to the design-states suite
- [ ] 4.5 Test: switcher rendering, keyboard operation, delete-active confirmation

## 5. End-to-end

- [ ] 5.1 E2E journey: create two workspaces on two connections, switch, quit and relaunch, text restored, nothing executed; declare `covers(...)` for the workspaces scenarios

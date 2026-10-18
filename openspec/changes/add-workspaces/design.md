## Context

Today `workspaceStore` holds one list of tabs, and the app restores it after a restart (`app-shell › Persisted workspace state`). Consoles are bound to one connection each and can be linked to files under the connection's Scripts folder. The connection model already has an environment (local, development, staging, production) that drives the stripe color and the production safeguards.

## Decisions

### A workspace is data, not a window
A workspace is a row (`id`, `name`, `kind` = `named` | `connection` | `last_session`, `connection_id` for defaults, `tabs` JSON, `active_tab`, `updated_at`). Only one workspace is active; the tab strip always shows the active one. No multi-window support in this change.

### Tab snapshot
Each saved tab holds `{kind, connection_id, title, text, saved_text?, file_path?, cursor}`. Results, sessions, transactions and AI conversations are not stored. This matches what restart restore keeps today, so switching is as safe as relaunching.

### Environment is derived, not stored
The environment of a workspace is computed from its tabs' connections when the switcher opens. This avoids stale data when a connection's environment is edited and avoids a second source of truth.

### Auto-save and when it runs
The active workspace is saved on a 2-second debounce after tab changes, on switch, and on quit; the same path replaces the current "save tabs on quit" code. Connection default workspaces are updated from the consoles bound to that connection, so closing tabs in a named workspace does not erase a connection's default.

### Restore is passive
Restoring reuses the existing lazy path: a console is created bound to its connection id with no session; the session opens on the first run. Production consoles reuse the production default (read-only) already applied to new consoles.

### Switch flow reuses closing rules
Switching is "close all tabs of the current workspace, then open the target's" and reuses the unsaved-file prompt and the open-transaction prompt that quitting and closing use (`settleTransactionsBeforeQuit`), so there is one set of rules.

### Migration
A one-time migration reads the existing saved tab list and writes it as the `last_session` row; the old key is left in place for one release as a rollback.

## Risks / Trade-offs

- [Large consoles make the store big] → Store text as-is but cap a workspace at 5 MB with a clear message; consoles above that are saved as files first.
- [A workspace references a deleted connection] → Spec'd: tab opens with text and a Bind action.
- [Two named workspaces open the same file] → Allowed; the file's dirty-state prompt applies when either is switched away.

## Open Questions

- ~~Shortcut for the switcher~~ Decided: Mod+Alt+W (Cmd+Shift+W is "close window" on macOS).
- Should named workspaces be exportable/importable as files (for sharing a checklist)? Out of scope for this change.

## Implementation notes

Differences from the plan above, decided while building:

- **No Rust table.** Workspaces are stored in the existing `ui_state` key/value store (`workspaces.index` and one `workspace.<id>` blob each), reusing `serializeSession` / `parseSession`: the per-kind serializers, the 5 MB cap and the lazy restore are exactly what restart restore already does. No backend change, so no new commands to test or secure.
- **Migration is a no-op by design.** The Last session blob keeps the old key (`session.tabs`), so a session saved before workspaces existed already is the Last session. There is nothing to copy and nothing to roll back.
- **`session.ts` gained three small hooks** (a settable save target, a pause during switches, an after-save listener) so it stays independent of the workspace store; with the defaults it behaves as before and its tests are unchanged.
- **Closing tabs edits the open workspace**, because the open workspace always saves what is open. Starting a different set of tabs therefore needs "New workspace…" (added to the spec as *Starting a workspace*); Save workspace as… copies the current tabs into a new workspace and leaves the old one as saved.
- **Connection defaults appear in the switcher** as workspaces named after the connection, next to the named ones, so a connection with consoles shows up under its environment. The list can show the same consoles under three names (Last session, a named workspace, the connection); that is accepted for now.
- **Deleted connection:** the console now shows "Connection no longer exists", keeps its text visible and offers Bind to connection… (before, it showed only an error and hid the text).
- **Design-states suite (task 4.4):** there is no canvas for the switcher yet, so it is not added to the design-states suite; the menu was checked against a screenshot of the real app instead. Add it when a canvas exists.
- **Not done:** the switcher does not yet show per-workspace tab titles; production read-only on restore is the existing connection safeguard (the restored production console shows its READ-ONLY badge in the journey) rather than workspace logic.

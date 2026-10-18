## Why

Clew restores one global list of open tabs after a restart. People who work against several databases (a local one, staging, production) end up with all of their consoles mixed in one tab strip, lose a set of consoles when they close tabs to focus on something else, and cannot keep a "release checklist" or "incident" set of consoles to come back to. DataGrip answers this with projects and per-data-source consoles; Clew needs the same: save the consoles you have open as a named **workspace**, keep a default workspace per connection, and switch between them without losing text or reconnecting by surprise.

## What Changes

- Add **workspaces**: a named set of open tabs (consoles with their text, bound connection, file link, cursor, and the active tab). A workspace can be saved, renamed, switched to, duplicated and deleted.
- Add a **default workspace per connection**: opening a connection's Scripts or using "Open workspace" for it restores the consoles last used with it. Workspaces are grouped by **environment** (local, development, staging, production) in the switcher, and a workspace whose consoles all share one environment shows that environment's stripe.
- Switching workspaces first saves the current one automatically (unless it is unsaved scratch and the user chooses to discard it), then restores the target. Restoring never runs SQL and never opens connections until the user runs something.
- The **last session** is kept as a built-in workspace, replacing the single global tab list; existing sessions migrate into it.
- Workspace switcher in the toolbar, Workspaces entries in the command palette, shortcuts through the registry.

## Capabilities

### New Capabilities
- `workspaces`: workspace model, save and switch, per-connection defaults, environment grouping, safe restore, migration of the last session.

### Modified Capabilities
- `app-shell`: "Persisted workspace state" restores the last active workspace instead of one global tab list.

## Impact

- Frontend: `src/features/workspaces/` (store, switcher UI, dialogs), `src/stores/workspaceStore.ts` (tab list becomes the active workspace), toolbar and palette registration.
- Rust: a `workspaces` table in `clew.db` (id, name, scope, tabs JSON, updated_at) with commands to list, save, load, rename, duplicate and delete; migration of the existing saved tab list into the "Last session" row.
- Privacy: workspaces hold console text locally, as session restore does today; no secrets are stored and nothing is sent anywhere.
- Needs the end-to-end journey for switching workspaces (E2E task group).

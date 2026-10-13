## Why

Every console and table tab in Clew holds its own database session, and in manual transaction mode a session can sit inside an open transaction for hours without anyone noticing: holding locks, blocking other writers, and on production, causing real harm. DataGrip's Services window gives one place to see every session and transaction, cancel a running statement, commit or roll back, close sessions, deactivate a connection and choose the transaction isolation level. Clew has no such overview: the only hints are the per-tab transaction chip and a prompt when closing.

## What Changes

- **Sessions panel:** a bottom panel (toggle Mod+Alt+S, status bar item "Sessions 4 · 1 idle in transaction") listing connections and their sessions with state, elapsed time and statement count, as in `design/canvas/Sessions.dc.html`.
- **Session details and actions:** backend id, timing, isolation level, the last statements of the open transaction, and Cancel, Commit, Roll back, Close session, Close all sessions, Deactivate connection and Go to tab.
- **Switch session:** attach a console or script to another session of the same connection or to a new one.
- **Idle-in-transaction warnings:** after a configurable time (default 5 minutes, 2 on production) the session is flagged in the panel, the tab, the status bar and, once, with a notification; one action rolls back all idle transactions.
- **Transaction isolation level:** a per-session selector for the levels the database supports, with a per-connection default.
- **Quit and deactivate** list every session with an open transaction in one dialog.

Canvas screen implemented: `design/canvas/Sessions.dc.html` (Sessions panel, switch-session menu, details, isolation chip, status bar item).

Not in this change (candidate): a server-wide activity monitor (other users' sessions, kill backend).

## Capabilities

### New Capabilities
- `session-manager`: the Sessions panel, session states and details, actions, switch session, idle-in-transaction handling and the quit dialog.

### Modified Capabilities
- `sql-console`: adds the transaction isolation level selector.
- `driver-framework`: adds session state reporting and isolation level support.

## Impact

- Rust: `SessionManager` gains per-session metadata (state, last activity, statement counter, isolation), events over a Tauri channel, and commands `sessions_list`, `session_commit`, `session_rollback`, `session_set_isolation`, `session_close_all`, `connection_deactivate`; drivers implement `backend_id`, `set_isolation` and `transaction_state`.
- Frontend: `src/features/sessions/` (panel, tree, details, menus, status item), console toolbar isolation control, idle timers and notifications.
- Depends on `add-sql-console`, `add-production-safeguards` and `add-driver-framework`.

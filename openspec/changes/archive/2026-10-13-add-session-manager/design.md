## Context

`SessionManager` (Rust) maps session ids to sessions and cancel handles; each console or table tab owns one session. The Tx chip already tracks Auto/Manual and a statement count in the frontend. DataGrip's Services window (https://www.jetbrains.com/help/datagrip/services-tool-window.html) is the reference for the controls: Tx mode and isolation, Commit and Roll back, Cancel, Close session, Close All Sessions, Switch Session and Deactivate. Idle-in-transaction thresholds, the warning treatment and the quit dialog are Clew's own additions.

## Goals / Non-Goals

**Goals:** one place to see and control every session; make forgotten transactions impossible to miss, especially on production; isolation level control.
**Non-Goals:** other users' sessions or a server activity monitor; killing server backends other than our own; connection pooling controls.

## Decisions

### Session metadata and events
`SessionMeta { id, connection_id, tab_id, name, state, started_at, last_activity_at, tx_started_at, tx_statement_count, tx_statements: ring buffer(20) { at, kind, text }, isolation, backend_id, read_only }` lives next to each session in `SessionManager`. Every execute, commit, rollback and state change updates it and emits `SessionEvent` on a broadcast channel; the frontend subscribes once (`sessions_subscribe(channel)`) and keeps a Zustand store. Running time is rendered client-side from `started_at`, so no polling.
Statement text is kept in memory only, truncated to 2,000 characters, and cleared when the transaction ends.

### State detection
`idle`/`in_transaction` follow the manager's own commit/rollback bookkeeping; `aborted` comes from driver error classification (PostgreSQL SQLSTATE 25P02 on the next statement, or error inside a transaction without savepoint) and is cleared by rollback. Drivers also expose `transaction_state()` (PostgreSQL `PQtransactionStatus` equivalent via `SHOW transaction_isolation`/`txid_current_if_assigned()`; MySQL `@@in_transaction` where available) to reconcile after unexpected failures.

### Isolation
`Session::set_isolation(level)`: PostgreSQL `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL …` (applies to following transactions) plus `SET TRANSACTION …` when a transaction is already open and has not run a query yet; MySQL/MariaDB `SET SESSION TRANSACTION ISOLATION LEVEL …`; SQL Server `SET TRANSACTION ISOLATION LEVEL …`; Oracle `SET TRANSACTION ISOLATION LEVEL …` per transaction (re-applied at BEGIN). The connection default is stored in `advanced.isolation` and applied at session open.

### Switch session
Tabs refer to a session by id. "Attach to" rebinds the tab's `session_id`; the old session closes if no tab uses it. A per-session async mutex serialises statements from several tabs; the waiting tab shows the holder's name from `SessionMeta.name`.

### Idle-in-transaction timer
A single 15-second ticker in the frontend compares `now - last_activity_at` for sessions with `state = in_transaction` against the threshold (settings; production default 120 s). Crossing the threshold sets `idle_flag` in the store; the notification fires once per transaction. Roll back all idle calls `session_rollback` for each flagged session after confirmation.

### Panel UI
`src/features/sessions/` with `SessionsPanel`, `SessionTree` (ARIA tree, keyboard navigation), `SessionDetails`, `SwitchSessionMenu`, `SessionsStatusItem`. It is a bottom dock registered with the workspace's panel slots, so its toggle follows the app-shell rule that every hidden area has a visible way back at every width; menus use the shared overlay helper.

### Quit dialog
`quit.tsx` (already prompting per console) collects sessions from the store and shows one dialog; "Review in Sessions panel" cancels the quit and opens the panel.

## Risks / Trade-offs

- [Misreporting transaction state after server-side failures] → Reconcile with `transaction_state()` after errors and reconnects; unit tests with fault injection.
- [Notifications annoy on local databases] → Thresholds are per environment; local and development default to 15 minutes and no notification, only the badge.
- [Statement text in the panel is sensitive] → Memory only, truncated, own consoles only, never in logs or diagnostics.
- [Shared sessions surprise users] → Explicit menu, the tree shows shared tabs under one session, queued tabs say who they wait for.

## Open Questions

- Should closing a console tab with a shared session close the session only when the last tab goes? (Proposed: yes.)

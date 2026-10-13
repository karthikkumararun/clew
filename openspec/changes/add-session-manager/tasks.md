## 1. Session metadata and events

- [x] 1.1 `SessionMeta` with state, timing, statement ring buffer, isolation, backend id, read-only; updated by execute, commit, rollback and errors (spec: session-manager › Session states)
- [x] 1.2 `SessionEvent` broadcast and `sessions_subscribe` / `sessions_list` commands
- [x] 1.3 Driver `backend_id`, `transaction_state`, `supported_isolation_levels`, `set_isolation` for PostgreSQL, MySQL/MariaDB and SQLite (spec: driver-framework › Session state and isolation level)
- [x] 1.4 Aborted-transaction detection and rollback clearing on PostgreSQL
- [x] 1.5 Test: state transitions idle → running → in transaction → aborted → idle against real PostgreSQL and MySQL; statement text cleared when the transaction ends

## 2. Actions

- [x] 2.1 Commands `session_commit`, `session_rollback`, `session_close`, `session_close_all`, `connection_deactivate` (with SSH tunnel teardown) (spec: session-manager › Session actions)
- [x] 2.2 Per-session async mutex and queued execution for shared sessions with "Waiting for …" (spec: session-manager › Switch session)
- [x] 2.3 Rebinding a tab to another or a new session; closing the last tab closes the shared session (the console rebinds through `session_attach` / `session_detach`; the session closes with its last tab)
- [ ] 2.4 Test: attach shares temp tables; queued statements run in order; deactivate with open transactions asks first (backend: queued statements run in order and the waiting session names its holder, covered in `sessions/tests.rs`; the deactivate dialog is covered by unit tests; the shared temp-table case is not tested)

## 3. Sessions panel UI

- [x] 3.1 Bottom dock with toolbar, tree and details per `design/canvas/Sessions.dc.html`; Mod+Alt+S, status bar item and palette command; restored visibility and height (spec: session-manager › Sessions panel)
- [x] 3.2 Session tree rows with live state, elapsed time, statement counts and the environment colours; filter field
- [x] 3.3 Details pane with identifiers, timings, breakdown, last statements and isolation selector (spec: session-manager › Session details)
- [x] 3.4 Switch session menu ("Attach … to") with the overlay helper
- [x] 3.5 Test: component tests for each state label and action enablement; hidden panel reopens from the status bar item at 1440 and 880 px

## 4. Idle-in-transaction

- [x] 4.1 Settings for thresholds (default 5 min, production 2 min, local 15) and notifications (spec: session-manager › Idle-in-transaction warnings)
- [x] 4.2 Ticker, flags on row, tab dot and status bar item; one notification per transaction with Roll back and Show
- [x] 4.3 "Roll back all idle" with confirmation
- [x] 4.4 Test: flag appears at the threshold, clears on activity, notification fires once

## 5. Isolation level and quit

- [x] 5.1 Isolation selector in the console Tx menu and details pane; connection default in Advanced settings; commit/rollback prompt when changing inside a transaction (spec: sql-console › Transaction isolation level) (`advanced.isolation` applied at session open; `session_set_isolation` refused inside a transaction, the UI asks Commit or Roll back first)
- [x] 5.2 One quit/close/deactivate dialog listing all sessions in transactions (spec: session-manager › Open transactions on quit)
- [x] 5.3 Test: level applies to the next transaction; quit dialog lists both sessions

## 6. End-to-end

- [x] 6.1 E2E: add journey J-23 in `e2e/specs/` — two consoles on one connection, one leaves a transaction open, the Sessions panel flags it as idle (with a shortened threshold), Roll back from the panel, attach a script to another session, change isolation (J-23 drives one console and a second database connection for checks; attach goes to a new session; the idle threshold is the 1 minute minimum)
- [x] 6.2 Declare `covers(...)` for the session-manager scenarios it exercises
- [x] 6.3 Design suite state from `design/canvas/Sessions.dc.html`; overlay-integrity check on the switch-session menu; panel toggle reachable at 880 px

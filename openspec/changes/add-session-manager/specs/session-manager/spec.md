## ADDED Requirements

### Requirement: Sessions panel
The workspace SHALL have a Sessions panel docked at the bottom, toggled with Mod+Alt+S, the status bar item and the command palette, matching `design/canvas/Sessions.dc.html`: a toolbar (Cancel running statement, Commit, Roll back, Close session, Close all sessions, Deactivate connection, a filter field, Hide), a tree of connections with their sessions on the left and the selected session's details on the right. Each connection row SHALL show the driver badge, name, environment dot and label, and a summary ("4 sessions · 1 in transaction") or "disconnected". The panel's visibility and height SHALL be restored after a restart, and its toggle SHALL always be reachable at every window size.

#### Scenario: Open the panel
- **WHEN** the user presses Mod+Alt+S
- **THEN** the panel opens with every connected connection expanded and the active tab's session selected

#### Scenario: Hidden panel can be reopened
- **WHEN** the panel was hidden and the app restarts at a narrow window
- **THEN** the status bar item and the palette command still open it

#### Scenario: Filter
- **WHEN** the user types "report" in the filter
- **THEN** only sessions whose names match remain, with their connections

### Requirement: Session states
Each session row SHALL show its tab or file name and its state: Idle (green), Running with elapsed time and the start of the statement (blue), In transaction with the time the transaction has been open and the number of statements (amber, red on production), Failed transaction (aborted; red), or Disconnected (grey). Rows SHALL update live without manual refresh.

#### Scenario: Running statement
- **WHEN** a console runs a 12 second query
- **THEN** its row shows "Running 00:12" counting up and returns to Idle when it finishes

#### Scenario: Open transaction
- **WHEN** a manual-mode console submits an update and does not commit
- **THEN** its row shows "In transaction" with the elapsed time and "1 statement"

#### Scenario: Server dropped the session
- **WHEN** the server closes a session's connection
- **THEN** its row shows Disconnected and the next use reconnects

### Requirement: Session details
Selecting a session SHALL show: its name and state; connection and database; server version and transport; the server's identifier for the session; started and last activity times; for an open transaction the statement count with a breakdown by kind and the last statements with timestamps; the isolation level with a selector; and read-only or read-write mode. Statement text SHALL be shown only for the user's own consoles and never leave the machine.

#### Scenario: Details of a transaction
- **WHEN** the user selects the session "orders (table editor)" that has 7 statements in a transaction
- **THEN** the pane shows the count breakdown and the last three statements with times

### Requirement: Session actions
For the selected session the toolbar and details SHALL offer: Cancel running statement (while running), Commit and Roll back (while in a manual transaction), Close session (asks to commit or roll back if a transaction is open, then closes its tab's session, which reconnects on next use), Go to tab, and, for a connection, Close all sessions and Deactivate connection (closes every session and the SSH tunnel after asking about open transactions; the connection stays in the explorer as disconnected).

#### Scenario: Cancel
- **WHEN** the user cancels a running session from the panel
- **THEN** the statement stops as if cancelled in its console and the row returns to Idle

#### Scenario: Deactivate with open transactions
- **WHEN** the user deactivates a connection with two sessions in transactions
- **THEN** a dialog lists both and offers Roll back all, Commit all and Cancel

#### Scenario: Close session
- **WHEN** the user closes a session that has no open transaction
- **THEN** it closes without a prompt, its tab stays open, and it reconnects when next used

### Requirement: Switch session
A console or SQL file SHALL be attachable to another session of the same connection or to a new session from the session's menu ("Attach <name> to": its own session, each existing session, New session). Attaching tabs to one session shares its transaction, temporary tables and settings; statements from tabs sharing a session SHALL run one at a time, queued in order, and a tab waiting SHALL show "Waiting for <other tab>".

#### Scenario: Share a session
- **WHEN** the user attaches `weekly_report.sql` to the session of `console`
- **THEN** both run on the same connection, a temp table created in one is visible in the other, and the panel lists them under one session

#### Scenario: Queued execution
- **WHEN** two tabs on one session run statements at the same time
- **THEN** the second shows "Waiting for console" until the first finishes

### Requirement: Idle-in-transaction warnings
A session that has had an open transaction with no activity for longer than a threshold SHALL be flagged: default 5 minutes, 2 minutes for production connections, configurable in Settings. The flag SHALL show as a warning mark on the session row, as an amber (red on production) dot on its editor tab, in the status bar item ("1 idle in transaction"), and once per session as a notification with "Roll back" and "Show". The details pane SHALL explain the impact (locks, blocked writers, old row versions). "Roll back all idle" SHALL be available from the status bar item and the panel.

#### Scenario: Threshold reached
- **WHEN** a production session has been idle in a transaction for 2 minutes
- **THEN** the row, the tab and the status bar show the warning and one notification appears

#### Scenario: Activity resets
- **WHEN** the user runs a statement in the flagged session
- **THEN** the idle timer restarts and the warning clears until the threshold passes again

#### Scenario: Roll back all idle
- **WHEN** the user chooses Roll back all idle with two flagged sessions
- **THEN** a confirmation lists them and, on Confirm, both roll back

### Requirement: Open transactions on quit
Quitting Clew, closing a window or deactivating a connection with sessions in a transaction SHALL show one dialog listing every such session (connection, name, duration, statement count) with Commit all, Roll back all, Review in Sessions panel and Cancel, instead of asking per session.

#### Scenario: Quit with two open transactions
- **WHEN** the user quits with two sessions in transactions
- **THEN** one dialog lists both and quitting continues only after Commit all or Roll back all

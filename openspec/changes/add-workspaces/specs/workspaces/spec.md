## ADDED Requirements

### Requirement: Workspace model
A workspace SHALL be a named set of open tabs. For each tab it SHALL keep the kind, the bound connection, the console text, the saved-file link and saved text (so unsaved changes survive), the cursor position and the tab order, plus which tab is active. A workspace SHALL NOT store passwords, keys, query results or session state. Workspaces SHALL be stored locally in the app's data store.

#### Scenario: Save the current tabs
- **WHEN** the user chooses "Save workspace as…" and names it "Release checklist" with three consoles open
- **THEN** a workspace "Release checklist" exists holding those three consoles with their text, connections and order, and the active tab

#### Scenario: Nothing sensitive is stored
- **WHEN** a workspace is saved from consoles bound to connections that have passwords
- **THEN** the stored workspace contains connection ids and names only, never credentials or result data

### Requirement: Default workspace per connection
Each connection SHALL have a default workspace holding the consoles last used with it. Choosing "Open workspace" on a connection in the explorer SHALL restore that connection's default workspace. Consoles opened or edited for a connection SHALL update its default workspace automatically within 2 seconds of the change.

#### Scenario: Reopen a connection's consoles
- **WHEN** the user had two consoles open on `staging-pg`, closed them, and chooses Open workspace on `staging-pg`
- **THEN** both consoles reopen with their previous text, bound to `staging-pg`

#### Scenario: No default yet
- **WHEN** a connection has never had a console
- **THEN** Open workspace opens one empty console for it

### Requirement: Environment grouping
The workspace switcher SHALL list workspaces grouped by environment (Local, Development, Staging, Production, then Mixed). A workspace belongs to an environment when every console in it is bound to connections of that environment; otherwise it is Mixed. A workspace of one environment SHALL show that environment's stripe color on its entry and, when active, in the switcher button.

#### Scenario: Grouped list
- **WHEN** workspaces exist for `local-sqlite`, `staging-pg` and `prod-pg`, plus one holding consoles from staging and production
- **THEN** the switcher shows them under Local, Staging and Production, and the mixed one under Mixed

#### Scenario: Environment changes
- **WHEN** the environment of a connection is edited from Staging to Production
- **THEN** workspaces made only of its consoles appear under Production on the next open of the switcher

### Requirement: Switching workspaces
The system SHALL provide a workspace switcher in the toolbar and a Switch workspace action in the command palette. Switching SHALL first save the current workspace, then replace the open tabs with the target's, keeping each tab's text. If a tab bound to a file has unsaved changes, or any console has an open transaction, the user SHALL be asked how to proceed (Save, Discard or Cancel; the transaction prompt of closing a console) before the switch. Cancelling SHALL leave everything as it was.

#### Scenario: Switch keeps the work
- **WHEN** the user edits a scratch console in workspace A and switches to workspace B
- **THEN** workspace A is saved with that text, B's tabs open, and switching back to A shows the edited text

#### Scenario: Open transaction
- **WHEN** a console in the current workspace has an open transaction and the user switches
- **THEN** the user is asked to commit, roll back or cancel; cancelling keeps the current workspace open

#### Scenario: Unsaved file
- **WHEN** a console linked to `report.sql` has unsaved changes and the user switches
- **THEN** a Save / Discard / Cancel prompt appears, and Cancel aborts the switch

### Requirement: Safe restore
Restoring a workspace SHALL NOT execute SQL, SHALL NOT open database connections until the user runs something in a console (or explicitly connects), and SHALL restore consoles bound to production connections in their read-only default mode. A tab whose connection no longer exists SHALL still open with its text and show that the connection is missing, with a way to bind it to another connection.

#### Scenario: Restore does not run anything
- **WHEN** a workspace containing a console with `DELETE FROM orders` is restored
- **THEN** the text is in the editor, nothing was executed and no connection was opened

#### Scenario: Deleted connection
- **WHEN** a workspace is restored and one of its consoles was bound to a connection that has since been deleted
- **THEN** the console opens with its text and a notice "Connection no longer exists", and Bind to connection… offers the available connections

#### Scenario: Production stays read-only
- **WHEN** a workspace with a console on a production connection is restored
- **THEN** that console is read-only by default exactly as a newly opened production console

### Requirement: Managing workspaces
The user SHALL be able to rename, duplicate and delete workspaces from the switcher. Deleting the active workspace SHALL ask for confirmation and then keep its tabs open as an unsaved workspace. The built-in Last session workspace SHALL be restored on launch when no other workspace was active, SHALL be overwritten by quitting, and SHALL NOT be deletable.

#### Scenario: Duplicate
- **WHEN** the user duplicates "Release checklist"
- **THEN** "Release checklist copy" appears with the same consoles, and editing one does not change the other

#### Scenario: Delete the active workspace
- **WHEN** the user deletes the workspace they are using and confirms
- **THEN** the workspace disappears from the list and its tabs remain open

#### Scenario: Last session
- **WHEN** the user quits with tabs open and relaunches
- **THEN** the same tabs reopen, as before workspaces existed

### Requirement: Migration
On first launch after the update, the previously saved tab list SHALL become the Last session workspace, with no tab or text lost.

#### Scenario: Upgrade from a single tab list
- **WHEN** a user with three saved console tabs updates and launches Clew
- **THEN** the three consoles open as before and the Last session workspace holds them

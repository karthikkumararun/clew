# database-explorer Specification

## Purpose
TBD - created by archiving change add-database-explorer. Update Purpose after archive.
## Requirements
### Requirement: Explorer tree
The sidebar SHALL show an EXPLORER panel with every saved connection grouped by connection group (default groups follow environment: PRODUCTION, STAGING, LOCAL…). Each connection row SHALL show a driver badge, the name, an environment-colored dot and, on the right, the host or "disconnected".

#### Scenario: No connections
- **WHEN** there are no saved connections
- **THEN** the panel shows "No connections yet" with a "New connection" button and an "Import…" link

#### Scenario: Group order
- **WHEN** the user drags a connection onto another group
- **THEN** the connection moves to that group and the change is saved

### Requirement: Lazy expansion
Expanding a node SHALL load its children on demand and show a loading indicator on that row only. Object groups SHALL show their child count. Tables SHALL show an estimated row count (e.g. "12.4k"). Columns SHALL show a key icon for primary keys, a link icon and "→ table" for foreign keys, and their type.

#### Scenario: Expand a disconnected connection
- **WHEN** the user expands a connection that is not connected
- **THEN** the system connects first (prompting for a password if needed), then shows its databases

#### Scenario: Load error
- **WHEN** loading a node's children fails
- **THEN** the node shows a red error row with the message and a Retry button, and siblings are unaffected

#### Scenario: Refresh
- **WHEN** the user selects a node and presses Refresh (or Mod+R in the explorer)
- **THEN** that node's subtree reloads, keeping which children were expanded

### Requirement: Filter
The filter field SHALL narrow the tree to nodes whose name matches (case-insensitive substring) among the nodes already loaded, keeping ancestors visible and highlighting the matched text.

#### Scenario: Filter tables
- **WHEN** the user types "ord" in the filter
- **THEN** only `orders`, `order_items` and their ancestors remain visible, with "ord" highlighted

#### Scenario: Nothing matches
- **WHEN** nothing loaded matches
- **THEN** the panel shows "No loaded objects match — use Mod+K to search everything"

### Requirement: Keyboard navigation
The tree SHALL support Up/Down to move, Right to expand or go to the first child, Left to collapse or go to the parent, Enter to perform the node's default action, and type-ahead to jump to the next visible node starting with the typed letters. The tree SHALL be exposed as an ARIA tree.

#### Scenario: Default action on a table
- **WHEN** a table is selected and the user presses Enter
- **THEN** the table opens in the table editor (`add-data-grid`)

#### Scenario: Default action on a connection
- **WHEN** a connection is selected and the user presses Enter
- **THEN** a new SQL console opens for it

### Requirement: Context actions
Right-clicking a node (or pressing the context-menu key / Shift+F10) SHALL open a menu with actions for its kind:
- Connection: Connect/Disconnect, New console, Edit…, Duplicate, Rename, Change environment, Delete…, Refresh.
- Database/schema: New console here, Refresh, Copy name.
- Table/view: Open data, Open in console (`SELECT * FROM … LIMIT 100`), Copy name, Copy qualified name, Generate DDL, Count rows, Refresh.
- Column: Copy name, Filter table by this column.

#### Scenario: Generate DDL
- **WHEN** the user chooses Generate DDL on `orders`
- **THEN** a new console tab opens containing the CREATE TABLE statement (with indexes and constraints) for that table

#### Scenario: Count rows
- **WHEN** the user chooses Count rows on a table
- **THEN** the exact count is fetched in the background and replaces the estimate on that row

### Requirement: Persisted explorer state
The system SHALL remember which nodes were expanded and the selected node, and restore them after a restart without connecting automatically; nodes under disconnected connections are restored when the connection next connects.

#### Scenario: Restart
- **WHEN** the user restarts with `prod-postgres › analytics › public › tables` expanded
- **THEN** after `prod-postgres` connects, that path is expanded again

### Requirement: Selected-node sync
When the active editor tab is a table editor, the explorer SHALL reveal and highlight that table's node (2px accent inset bar).

#### Scenario: Switch tab
- **WHEN** the user switches to the `orders` table tab
- **THEN** the explorer scrolls to and highlights `orders`

### Requirement: Scripts node
Each connection in the explorer SHALL show a "Scripts" node listing the SQL files linked to it (from its Scripts folder), with New script, Reveal in Finder/Explorer and Refresh actions. Opening a script SHALL open it in a console bound to that connection.

#### Scenario: Open an imported console
- **WHEN** the user double-clicks `monthly_revenue.sql` under `analytics-prod › Scripts`
- **THEN** it opens in a console tab bound to `analytics-prod`, titled with the file name

#### Scenario: File removed on disk
- **WHEN** a linked file was deleted outside Clew
- **THEN** the Scripts node drops it on the next refresh

### Requirement: Default grouping by environment
While the user has created no groups of their own, the explorer SHALL group connections under the headers PRODUCTION, STAGING, DEVELOPMENT and LOCAL, in that order, placing each connection under the header of its environment and hiding headers that would be empty. As soon as the user creates a group, the user's groups SHALL be used instead, and connections without a group appear under "Ungrouped".

#### Scenario: All four environments
- **WHEN** there are connections in Production, Staging, Development and Local and no user-created groups
- **THEN** the explorer shows four headers in the order PRODUCTION, STAGING, DEVELOPMENT, LOCAL, each with its connections

#### Scenario: Empty headers are hidden
- **WHEN** there are only Production and Local connections
- **THEN** only PRODUCTION and LOCAL headers appear

#### Scenario: Environment change moves the connection
- **WHEN** the user changes a connection's environment from Local to Staging
- **THEN** it moves under the STAGING header

#### Scenario: User creates a group
- **WHEN** the user creates a group called "Client A" and moves a connection into it
- **THEN** the explorer switches to the user's groups, showing "Client A" and "Ungrouped" with the remaining connections, and no environment headers


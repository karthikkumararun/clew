## ADDED Requirements

### Requirement: Table editor tab
Opening a table or view SHALL open a table-editor tab matching `design/canvas/DataGrid.dc.html`: a breadcrumb (env dot, connection › database › schema › **table**), a view switcher Data / Structure / Indexes / Relations / DDL, an environment badge for production, and "Open in console".

#### Scenario: Open a table
- **WHEN** the user double-clicks `orders` in the explorer
- **THEN** a tab titled `orders` opens on the Data view showing the first page sorted by primary key

#### Scenario: Open in console
- **WHEN** the user clicks Open in console
- **THEN** a new console opens with the SELECT that the current filter, sort and page produce

### Requirement: Filter and order
The Data view SHALL have a WHERE input and an ORDER BY input that take raw SQL fragments (with completion of column names), applied on Enter. Invalid fragments SHALL show the database error under the input without clearing the grid.

#### Scenario: Apply a filter
- **WHEN** the user enters `status = 'pending' AND total > 100` and presses Enter
- **THEN** the grid reloads with matching rows and the row count updates

#### Scenario: Quick filter from a cell
- **WHEN** the user right-clicks a cell with value `pending` and chooses Filter › Equals
- **THEN** `status = 'pending'` is added to the WHERE input (ANDed with what is there) and applied

#### Scenario: Bad filter
- **WHEN** the WHERE fragment has a syntax error
- **THEN** the error appears under the input in `--danger`, and the previous rows stay visible

### Requirement: Paging and counts
The Data view SHALL page with a page size of 100, 500 or 1,000 and show "Rows <from>–<to> of <count> · <ms> ms", where the count is exact for tables under 1 million estimated rows and otherwise shown as "≈<estimate>" with a "Count exactly" action.

#### Scenario: Next page
- **WHEN** the user clicks next page on page 1 of 1,284 rows with page size 100
- **THEN** rows 101–200 load

### Requirement: Staged inline editing
On editable results (a single table with a primary key or unique key, and a connection not in read-only mode), the user SHALL be able to edit cells (Enter or double-click; type-appropriate editors: text, number, boolean toggle, enum dropdown, date/time picker, JSON editor, "Set NULL", "Set DEFAULT"), add rows (+ / Mod+N) and delete rows (− / Mod+Backspace). Changes SHALL NOT be written until submitted and SHALL be shown as: edited cell `--grid-edited-cell` with an accent ring and its row tinted `--grid-edited-row`; inserted row `--grid-inserted-row` with a green "+" marker; deleted row `--grid-deleted-row`, struck through, with a red "−" marker.

#### Scenario: Edit a cell
- **WHEN** the user changes `status` of order 88213 from `pending` to `shipped`
- **THEN** the cell is marked edited, the record panel shows "was pending", and the pending bar shows "1 pending change"

#### Scenario: Not editable
- **WHEN** a console result joins two tables, or the table has no primary/unique key
- **THEN** cells are read-only and the toolbar explains why ("Read-only: result has no unique key")

#### Scenario: Undo a single change
- **WHEN** the user presses Mod+Z after editing a cell
- **THEN** that edit is reverted and the pending count decreases

### Requirement: Pending changes bar and submit
When changes are pending, a bar SHALL appear at the bottom (`--pending-bar-*` tokens) reading "<n> pending changes" with a breakdown ("1 edited · 1 inserted · 1 deleted — nothing is written until you submit") and buttons Preview SQL, Revert all and Submit (Mod+S). Submit SHALL run all generated statements in one transaction; on any failure it SHALL roll back and keep every change pending.

#### Scenario: Preview SQL
- **WHEN** the user clicks Preview SQL
- **THEN** a dialog shows the exact UPDATE / INSERT / DELETE statements, each keyed by primary key, with Copy and "Open in console"

#### Scenario: Submit succeeds
- **WHEN** the user submits 3 changes and the transaction commits
- **THEN** the markers clear, the affected rows reload from the database, and Output logs the statements

#### Scenario: Submit fails
- **WHEN** one INSERT violates a NOT NULL constraint
- **THEN** the transaction is rolled back, the failing row is highlighted with the error message, and all 3 changes remain pending

#### Scenario: Row changed by someone else
- **WHEN** an edited row's original values no longer match the database at submit time (optimistic check on the edited columns)
- **THEN** that UPDATE affects 0 rows, the submit rolls back and the user is told the row changed and offered Reload row

#### Scenario: Leaving with pending changes
- **WHEN** the user closes the tab, changes page or changes the filter with pending changes
- **THEN** the system asks Submit / Discard / Cancel

### Requirement: Record panel
The table editor SHALL show a record panel on the right (toggle Mod+Shift+R) for the selected row: "Record #<pk>" with Copy as JSON, each column as a mono key/value line (changed values show "was <old>"), a REFERENCES section listing FK targets as links (e.g. "users #1042 · Ada Lovelace · ada@example.com" using the target's first text columns), and a REFERENCED BY section listing referencing tables with row counts.

#### Scenario: Follow a reference
- **WHEN** the user clicks "users #1042" in REFERENCES
- **THEN** the `users` table opens filtered to `id = 1042`

#### Scenario: Referenced by
- **WHEN** the user clicks "order_items · 3 rows"
- **THEN** `order_items` opens filtered to `order_id = 88213`

### Requirement: Structure, indexes, relations and DDL views
The Structure view SHALL list columns (name, type, nullable, default, PK/FK, comment); Indexes SHALL list indexes (name, columns, unique, method, size); Relations SHALL list outgoing and incoming foreign keys; DDL SHALL show the read-only CREATE statement with Copy and Open in console.

#### Scenario: View structure
- **WHEN** the user switches to Structure on `orders`
- **THEN** each column appears with its type, nullability, default and key markers

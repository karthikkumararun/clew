## ADDED Requirements

### Requirement: Grid rendering
The grid SHALL render rows virtually so that results of 1,000,000 rows scroll smoothly, with: a row-number column, sticky two-line headers (column name, then type in `--text-dim`), 26px rows, JetBrains Mono 12px, and value colors by kind (numbers `--syn-number` right-aligned, dates `--syn-date`, booleans `--syn-boolean`, NULL as italic "NULL" in `--syn-null`, FK values underlined in `--syn-link`).

#### Scenario: Scroll a large result
- **WHEN** a result holds 1,000,000 loaded rows
- **THEN** scrolling stays responsive (no frame longer than 50 ms on a 2020-era laptop)

#### Scenario: Truncated value
- **WHEN** a cell holds a truncated large value
- **THEN** it shows the start with a "…" marker, and opening the cell fetches the full value

### Requirement: Cell viewer
Pressing Shift+Enter (or double-clicking a read-only cell) SHALL open a value viewer with formatting for the kind: pretty-printed JSON with folding, hex + text for bytes, and wrapped text with character count for long strings.

#### Scenario: JSON cell
- **WHEN** the user opens a jsonb cell
- **THEN** the viewer shows indented, highlighted JSON with copy

### Requirement: Selection and copy
The grid SHALL support single-cell, range (Shift+click / Shift+arrows), whole-row and whole-column selection, and Mod+C copies as TSV with headers optional. A "Copy as" menu SHALL offer CSV, JSON, Markdown table and SQL INSERT statements.

#### Scenario: Copy a range
- **WHEN** the user selects 3 columns × 10 rows and presses Mod+C
- **THEN** the clipboard holds 10 tab-separated lines (NULL copied as an empty field)

#### Scenario: Copy as INSERT
- **WHEN** the user chooses Copy as › SQL INSERT on 2 rows of `orders`
- **THEN** the clipboard holds two INSERT statements for `orders` with correctly quoted values for the connection's dialect

### Requirement: Sorting and columns
Clicking a header SHALL sort by that column (asc → desc → none) with an accent arrow; for a table editor the sort is applied by the database, for console results it re-runs with ORDER BY only when the user confirms, otherwise sorts the loaded rows client-side and says so. Columns SHALL be resizable (double-click to auto-fit), reorderable by drag, and hideable from a Columns menu ("Columns · 6 of 9").

#### Scenario: Client-side sort notice
- **WHEN** the user sorts a console result that has more rows on the server
- **THEN** the loaded rows are sorted and a notice reads "Sorted 500 loaded rows — Re-run with ORDER BY"

### Requirement: Transpose
The grid SHALL toggle a transposed view where each row becomes a column, for comparing a few wide rows.

#### Scenario: Transpose one row
- **WHEN** a single-row result is transposed
- **THEN** the grid shows two columns: column name and value

### Requirement: Export
The system SHALL export a result set or a whole table to CSV, TSV, JSON (array or lines), Markdown or SQL INSERT, choosing loaded rows only or all rows (re-running the query and streaming to the file without loading it in memory), with options for header row, delimiter, NULL text and date format.

#### Scenario: Export all rows of a big table
- **WHEN** the user exports all 12 million rows of a table to CSV
- **THEN** the export streams to disk with a progress indicator and a Cancel button, and memory stays bounded

#### Scenario: Cancelled export
- **WHEN** the user cancels an export
- **THEN** the partial file is deleted

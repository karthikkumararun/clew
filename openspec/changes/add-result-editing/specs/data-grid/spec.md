## ADDED Requirements

### Requirement: Paste into the grid
In an editable grid (editable query result or table editor), Mod+V SHALL paste clipboard content into the selected cells. Copying a range inside the grid and pasting it elsewhere SHALL keep its shape. Rules: a block pasted onto one selected cell fills right and down from it; a single value pasted onto a larger selection fills every selected cell; a block pasted onto a larger selection of the same shape repeats only if the selection is an exact multiple, otherwise fills from the top-left. Read-only columns SHALL be skipped and reported. Each value SHALL be converted to its column's type, and values that cannot be converted SHALL be listed before anything is staged, with the choices "Paste the other values" and "Cancel". A paste SHALL be one undo step and SHALL stage changes like typed edits.

#### Scenario: Copy and paste inside the grid
- **WHEN** the user copies the `status` and `total` cells of two rows and pastes them onto two other rows
- **THEN** the four cells show the pasted values as edited and the pending bar counts two changed rows

#### Scenario: One value over a selection
- **WHEN** the user copies one status value and pastes it onto 5 selected status cells
- **THEN** all 5 cells get that value

#### Scenario: Read-only column skipped
- **WHEN** the paste block covers a read-only column
- **THEN** that column is skipped and the message says "1 read-only column skipped"

#### Scenario: Value that doesn't fit
- **WHEN** a pasted value "abc" lands in a numeric column
- **THEN** a dialog lists "Row 3, total: 'abc' is not a number" and offers to paste the other values or cancel, and nothing is staged until the user chooses

#### Scenario: One undo
- **WHEN** the user pastes a 3×2 block and presses Mod+Z
- **THEN** all six cells return to their previous values

### Requirement: Paste external data
Mod+V SHALL also accept text copied from outside Clew. The format SHALL be detected automatically from the text: tab-separated values; CSV with comma, semicolon or pipe delimiters and quoted fields; Markdown tables; and JSON arrays of arrays or of objects. A header row whose names match the grid's column names (case-insensitive) SHALL map values to columns by name regardless of order; otherwise values map by position from the selected cell. After pasting, a notice SHALL say "Pasted <r> rows × <c> columns · <format>" with "Interpret as" (Tab-separated, CSV comma, CSV semicolon, CSV pipe, Markdown table, JSON array, One value) and Undo. A default paste format MAY be set in the grid options.

#### Scenario: CSV with header
- **WHEN** the clipboard holds `id,status,total` followed by two data rows, copied from a spreadsheet export, and one cell is selected
- **THEN** the format is detected as CSV (comma), the header maps to columns by name, and the notice offers Interpret as

#### Scenario: Wrong detection
- **WHEN** the user chooses "CSV · semicolon" from Interpret as
- **THEN** the paste is redone with that format, replacing the earlier staged values

#### Scenario: JSON array
- **WHEN** the clipboard holds `[{"status":"shipped","total":10}]`
- **THEN** object keys map to columns by name

#### Scenario: Large paste
- **WHEN** a paste would stage more than 10,000 cells
- **THEN** the user is asked to confirm, and a paste over 100,000 cells is refused with a message suggesting a table import

### Requirement: Paste as new rows
Mod+Shift+V SHALL always paste pasted rows as new rows in an editable single-table grid. When a normal paste has more rows than fit below the selection and rows can be added, a dialog SHALL ask "Add N new rows?" with "Paste M rows only", "Add N rows" and Cancel.

#### Scenario: More rows than fit
- **WHEN** the user pastes 6 rows with 2 rows left below the selection
- **THEN** the dialog offers to paste 2, or add 4 new rows

#### Scenario: Paste as new rows
- **WHEN** the user presses Mod+Shift+V with 3 rows on the clipboard
- **THEN** three green inserted rows are added at the end

### Requirement: Aggregate view
When more than one cell is selected, a strip below the grid SHALL show the count of selected cells and, for the numeric cells among them, COUNT, SUM, AVG, MIN and MAX, calculated exactly (no floating point rounding for decimal columns) and formatted with the grid's number format. Mod+Shift+C SHALL copy the SUM. The strip SHALL be toggled from the options menu.

#### Scenario: Selected numbers
- **WHEN** the user selects the `total` cells with values 1150.00 and 300.00
- **THEN** the strip shows COUNT 2, SUM 1,450.00, AVG 725.00, MIN 300.00, MAX 1,150.00

#### Scenario: No numbers
- **WHEN** the selection holds only text
- **THEN** the strip shows the number of selected cells and no aggregates

### Requirement: Find on page
Mod+F with focus in the grid SHALL open a find field over the loaded rows. It SHALL highlight cells containing the text (case-insensitive, optional whole word and regular expression), show "<n> of <m>", move between matches with Enter and Shift+Enter, and scroll to them. Esc closes it.

#### Scenario: Find a value
- **WHEN** the user types "ship"
- **THEN** matching cells are highlighted, the count reads "3 of 8" and Enter jumps to the next match

### Requirement: Local filter
A local filter toggle SHALL show a filter row under the column headers. Each column filter SHALL accept: contains, equals, starts with, ends with, NULL, not NULL, and for numeric and date columns comparisons (=, ≠, <, >, ≤, ≥) and ranges. Filters combine with AND, apply only to loaded rows, never change the database or the statement, and show "Showing <n> of <m> rows". Rows with pending changes that are hidden SHALL be counted in a note.

#### Scenario: Two filters
- **WHEN** the user enters `contains ship` on status and `> 200` on total
- **THEN** only rows matching both stay visible and the count shows

#### Scenario: Clear
- **WHEN** the user clears the filters or turns the toggle off
- **THEN** all loaded rows show again

### Requirement: View as
The grid SHALL offer View as Table (default), Tree and Text, combinable with Transpose. Tree SHALL show each row's values as an expandable key-value tree, with JSON, arrays and structured types expanded in place with type colours. Text SHALL show all rows as text in the chosen data extractor format (CSV, TSV, Markdown table, JSON, SQL INSERT) in a read-only monospaced view that can be selected and copied.

#### Scenario: JSON in tree view
- **WHEN** a result has a jsonb column and the user switches to Tree
- **THEN** each row's JSON expands into keys and values

#### Scenario: Text view as CSV
- **WHEN** the user switches to Text and picks CSV
- **THEN** the rows appear as CSV text with a header, and Copy copies it

### Requirement: Value editor panel
The grid options menu SHALL toggle a value editor panel at the right of the grid showing the selected cell's full value with the column and row. It SHALL offer Display as (for binary: text, hex, base64, UUID; for timestamps and numbers: the display formats supported for that type) which only changes how the stored bytes or number are read, never the stored value, and Highlight as (plain, JSON, XML, SQL) for text. For text and binary cells it SHALL offer "Load file…" (replaces the value with a file's contents, as a staged edit) and "Save to file…" (writes the value to a file the user picks). Editing in the panel stages the same change as editing in the cell.

#### Scenario: Binary as UUID
- **WHEN** a 16-byte binary cell is selected and Display as is set to UUID
- **THEN** the panel shows the UUID text form and the stored bytes are unchanged

#### Scenario: Save a large value
- **WHEN** the user chooses Save to file on a 5 MB text cell
- **THEN** the full value, fetched from the database if it was truncated, is written to the chosen path

#### Scenario: Load a file
- **WHEN** the user loads a 2 MB file into a bytes cell in an editable result
- **THEN** the cell is staged as edited with the new size, and nothing is written until submit

### Requirement: Extractor options
Copy as, Copy, Export and the Text view SHALL share one set of extractor options: format (CSV, TSV, Markdown, JSON, JSON lines, SQL INSERT), header row, delimiter and quoting for CSV, NULL text, date format, and the toggles "Skip computed columns" and "Skip generated columns". The options SHALL be remembered per format.

#### Scenario: Skip computed columns
- **WHEN** the user copies rows as SQL INSERT with "Skip computed columns" on
- **THEN** columns like `with_tax` that are expressions are left out of the statements

### Requirement: Grid options menu
The More options menu (⋯) SHALL contain: Value editor, Aggregate view, Paste format, Reset view (column order, widths, hidden columns, sort, local filters), View query (shows the statement that produced the result), Copy query to console (opens it in a new console of the same connection), Copy query to clipboard, and Result settings.

#### Scenario: Reset view
- **WHEN** the user has reordered columns and hidden two, then chooses Reset view
- **THEN** the original order and all columns are restored

#### Scenario: Copy query to console
- **WHEN** the result came from a table editor tab and the user chooses Copy query to console
- **THEN** a new console opens with the SELECT behind the current page, filter and order

### Requirement: Go to row and related rows
Mod+G SHALL open "Go to row…" accepting a row number or a key value to scroll to and select that row among the loaded rows. The cell context menu SHALL offer "Related rows" for foreign key cells, opening the referenced or referencing rows (as in the record panel), and "Show DDL" and "Reveal in explorer" for the source table.

#### Scenario: Go to row
- **WHEN** the user presses Mod+G and types 150
- **THEN** row 150 is scrolled into view and selected

#### Scenario: Related rows
- **WHEN** the user chooses Related rows on a `user_id` cell
- **THEN** the `users` table opens filtered to that user

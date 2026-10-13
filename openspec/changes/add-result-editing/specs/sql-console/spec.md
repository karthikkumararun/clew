## ADDED Requirements

### Requirement: Auto-refresh
The results toolbar SHALL offer auto-refresh (Off, every 5, 10, 30 seconds, every minute, or a custom interval) which re-runs the result's statement. It SHALL apply only to statements classified as read, SHALL pause while the result has pending changes, the tab is not visible or the window is in the background, and SHALL stop on any error, showing the error in the Output tab. The current setting SHALL show in the toolbar.

#### Scenario: Every 10 seconds
- **WHEN** the user sets Every 10 seconds on a SELECT result
- **THEN** the statement re-runs every 10 seconds and the toolbar shows "Every 10 s"

#### Scenario: Not for writes
- **WHEN** the result came from an UPDATE ... RETURNING statement
- **THEN** auto-refresh is unavailable with "Only read statements can refresh automatically"

#### Scenario: Pending changes
- **WHEN** the result has staged edits and auto-refresh is on
- **THEN** refreshing pauses and the toolbar says "Paused: pending changes"

### Requirement: Result paging
A setting SHALL choose how results of the console are browsed: Scroll (default, rows load as the user scrolls) or Pages. In Pages mode the toolbar shows First, Previous, Next, Last, "<from>–<to>" and a page size choice (100, 500, 1,000, custom), with Mod+Alt+Up and Mod+Alt+Down for previous and next. Pages are windows over the loaded rows; moving forward loads more rows from the open cursor; Last asks for confirmation when it must load more than 100,000 rows.

#### Scenario: Next page
- **WHEN** the user presses Next on page 1 of a 5,000 row result with page size 500
- **THEN** rows 501–1,000 show

#### Scenario: Last page of a large result
- **WHEN** the user presses Last on a result with at least 1,000,000 rows
- **THEN** a confirmation says it will load all rows first

### Requirement: Output tab tools
The Output tab SHALL have a toolbar with soft wrap, auto-scroll to the latest entry, pause output (entries keep arriving but the view stops scrolling), and Clear. Its context menu SHALL offer Copy, Copy statement, and "Compare with clipboard". Entries SHALL show timestamp, statement summary, outcome, duration, rows affected and the transaction mode.

#### Scenario: Clear
- **WHEN** the user presses Clear
- **THEN** the log is emptied for this console and the history is unaffected

### Requirement: Plan tab details
The Plan tab SHALL offer Copy original plan (the plan in the database's own format: text, JSON or XML), a details pane for the selected plan node (all fields the database reports for it), cost bars that show each node's share of the total cost, and, when an AI provider is configured, "Explain with AI" that attaches the plan to a question in Ask mode. Analyzing a plan SHALL never run the statement unless Explain Analyze was explicitly chosen.

#### Scenario: Copy native plan
- **WHEN** the user presses Copy original plan on a PostgreSQL plan
- **THEN** the plan JSON as returned by `EXPLAIN (FORMAT JSON)` is on the clipboard

#### Scenario: Node details
- **WHEN** the user selects a Seq Scan node
- **THEN** the details pane lists relation, filter, rows estimated and actual (if analysed), width and costs

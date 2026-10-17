# command-palette Specification

## Purpose
TBD - created by archiving change add-command-palette. Update Purpose after archive.
## Requirements
### Requirement: Open the palette
Mod+K (and the toolbar search button "Go to table, query, action… ⌘K") SHALL open a palette overlay matching `design/canvas/CommandPalette.dc.html`: 680px wide, 120px from the top, a search input with scope tabs All / Objects / Queries / Actions, results grouped under section labels, and a footer with key hints and "Searching <n> connections · <m> objects indexed".

#### Scenario: Open and close
- **WHEN** the user presses Mod+K, then Esc
- **THEN** the palette opens with the input focused, then closes and focus returns where it was

#### Scenario: Scopes
- **WHEN** the user presses Tab (Shift+Tab goes back) or clicks a scope tab
- **THEN** the scope moves through All, Objects, Queries and Actions and wraps, the results show only that kind, and focus stays in the input

#### Scenario: Palette is fully visible
- **WHEN** the palette is open in a 1440 px wide window, and in an 880 px wide one
- **THEN** it lies inside the window, is not covered or clipped, and a long result list scrolls inside it

### Requirement: Fuzzy search
Typing SHALL fuzzy-match against object names, query text and action titles, ranking exact prefix matches first, then word-boundary matches, then recency, and highlight the matched characters in the accent color. Results SHALL appear within 50 ms for an index of 100,000 objects.

#### Scenario: Search "ord"
- **WHEN** the user types "ord"
- **THEN** `orders` (prod-postgres · analytics.public) and `order_items` appear first under TABLES & COLLECTIONS, then `orders` from staging-mysql, then a Mongo field match, then matching recent queries and actions such as "Export orders to CSV…"

#### Scenario: Empty query
- **WHEN** the palette opens with nothing typed
- **THEN** it lists the most recently indexed tables, the newest statements and saved files, and the actions, each section capped on the All scope

#### Scenario: Nothing found
- **WHEN** nothing matches
- **THEN** the palette shows "No matches" and suggests refreshing the index for disconnected connections

### Requirement: Result actions
Enter SHALL perform the result's default action (open table editor, collection, Redis key, file or saved query; run an action). Alt+Enter on an object SHALL open a new console with a starter query (`SELECT * FROM … LIMIT 100`, `db.<coll>.find({})`). Up/Down move, Tab cycles scope, and each result SHALL show its connection with env dot.

#### Scenario: Open in console
- **WHEN** `orders` is highlighted and the user presses Alt+Enter
- **THEN** a console for prod-postgres opens containing `SELECT * FROM analytics.public.orders LIMIT 100`, not executed

### Requirement: Actions from the command registry
Every command registered in the shell's command registry SHALL be searchable under ACTIONS with its shortcut shown, and context-aware actions SHALL include the current selection (e.g. "Export orders to CSV…", "Generate DDL for orders").

#### Scenario: Run an action
- **WHEN** the user searches "new conn" and presses Enter
- **THEN** the New connection dialog opens

### Requirement: Object index
The system SHALL maintain a local index of objects (tables, views, collections, Redis key prefixes, columns/fields) for every connection, updated whenever introspection runs and fully refreshed on demand. Objects of disconnected connections SHALL remain searchable from the last index and connect on open.

#### Scenario: Disconnected connection
- **WHEN** the user picks a table from a connection that isn't connected
- **THEN** the app connects (prompting for a password if needed) and opens the table

### Requirement: Recent files and queries
Mod+E SHALL open the palette scoped to recent files and saved queries, newest first.

#### Scenario: Recent files
- **WHEN** the user presses Mod+E
- **THEN** recently opened `.sql` files and saved queries are listed with the most recent first


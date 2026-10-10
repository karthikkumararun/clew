## Why

Users find their way around a database through the explorer tree: connections grouped by environment, then databases, schemas, tables and columns. It is also where most actions start (open data, new console, copy name, generate DDL).

## What Changes

- Add the Explorer sidebar panel from `design/canvas/Main.dc.html`: header with New connection / Refresh / Collapse all, a filter field, and a virtualized tree.
- Tree levels: environment groups → connections (driver badge, name, env dot, host hint or "disconnected") → databases → schemas → object groups with counts (tables, views, functions…) → objects (table row-count estimate) → columns (key / FK / plain icons with type, FK target).
- Lazy loading through `introspect_children`, with per-node loading and error states.
- Keyboard navigation, type-to-filter, and context menus with the common actions.
- Remember expanded nodes and selection across restarts.

Canvas screens implemented: the EXPLORER sidebar in `design/canvas/Main.dc.html` (and the condensed version in `AIAssistant.dc.html`).

## Capabilities

### New Capabilities
- `database-explorer`: the explorer tree, its loading/filtering, keyboard handling, context actions and persisted expansion state.

### Modified Capabilities
- (none)

## Impact

- Frontend: `src/features/explorer/` (ExplorerPanel, TreeRow, useTree store, context menu).
- Rust: `explorer_ddl` command (generate DDL for an object) per SQL driver.
- Depends on `add-driver-framework` and `add-connection-management`.

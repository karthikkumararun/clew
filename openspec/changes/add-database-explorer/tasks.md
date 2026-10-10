## 1. Tree state

- [ ] 1.1 Implement the normalized tree store with node states and flattened visible rows (spec: database-explorer › Lazy expansion)
- [ ] 1.2 Implement lazy loading via `introspect_children`, request coalescing, per-node error + Retry
- [ ] 1.3 Implement connect-on-expand (password prompt passthrough)
- [ ] 1.4 Test: expand/collapse, error isolation, refresh keeps expanded children

## 2. Explorer panel UI

- [ ] 2.1 Build ExplorerPanel header (New connection, Refresh, Collapse all) and the filter input per canvas (spec: database-explorer › Explorer tree)
- [ ] 2.2 Build TreeRow variants: group header, connection, database, schema, object group with count, table with estimate, column with key/FK/type
- [ ] 2.3 Virtualize rows with @tanstack/react-virtual; empty state
- [ ] 2.4 Drag a connection to another group
- [ ] 2.5 Test: renders canvas row variants; empty state; drag between groups

## 3. Filter and keyboard

- [ ] 3.1 Filter over loaded nodes with ancestor retention and highlight (spec: database-explorer › Filter)
- [ ] 3.2 ARIA tree roles and full keyboard navigation incl. type-ahead (spec: database-explorer › Keyboard navigation)
- [ ] 3.3 Test: filter "ord"; keyboard moves and default actions

## 4. Actions

- [ ] 4.1 Context menus per node kind, registered as commands (spec: database-explorer › Context actions)
- [ ] 4.2 Rust `explorer_ddl` for PostgreSQL and SQLite; open result in a new console
- [ ] 4.3 Rust `explorer_count_rows`; replace the estimate in place
- [ ] 4.4 Test: DDL for a fixture table matches golden output (both drivers)

## 5. Persistence and sync

- [ ] 5.1 Persist and restore expanded ids and selection (spec: database-explorer › Persisted explorer state)
- [ ] 5.2 Reveal and highlight the active table tab's node (spec: database-explorer › Selected-node sync)
- [ ] 5.3 Test: restore after simulated restart; reveal on tab switch

## 6. Scripts node

- [ ] 6.1 Scripts node per connection listing linked SQL files, with New script / Reveal / Refresh; open in a bound console (spec: database-explorer › Scripts node)
- [ ] 6.2 Test: imported file opens bound to its connection; deleted file disappears after refresh

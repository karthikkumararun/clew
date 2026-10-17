## 1. Index

- [x] 1.1 `palette_index` migration and update hooks from introspection and completion snapshots (spec: command-palette › Object index)
- [x] 1.2 `palette_search` with nucleo-matcher, ranking rules and match indices (spec: command-palette › Fuzzy search)
- [x] 1.3 Test: ranking order for the "ord" fixture; 100k objects under 50 ms
- [x] 1.4 Index graph labels and relationship types from `SchemaSnapshot.graph` (carried over from `add-graph-browser` 5.2; spec: graph-browser › Explorer, palette and AI integration); selecting one opens a graph console with the label query

## 2. Palette UI

- [x] 2.1 Overlay, input, scope tabs, grouped results, footer per canvas (spec: command-palette › Open the palette)
- [x] 2.2 Keyboard: Up/Down, Enter, Alt+Enter, Tab scope cycle, Esc with focus restore (spec: command-palette › Result actions)
- [x] 2.3 Actions section from the command registry with shortcuts and context-aware entries (spec: command-palette › Actions from the command registry)
- [x] 2.4 Connect-on-open for disconnected connections
- [x] 2.5 Mod+E recent files and saved queries preset (spec: command-palette › Recent files and queries)
- [x] 2.6 Test: Vitest for keyboard flows and default vs console actions

## 3. End-to-end

- [x] 3.1 E2E: add journey J-16 in `e2e/specs/` — Mod+K search across connections, open a table, Alt+Enter opens a console, connect-on-open for a disconnected connection
- [x] 3.2 Declare `covers(...)` for the scenarios it exercises (e.g. command-palette › Fuzzy search; command-palette › Result actions) and add the seed/compose service it needs to the matching profile

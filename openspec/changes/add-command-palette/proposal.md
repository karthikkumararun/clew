## Why

With many connections, schemas and tabs, mouse navigation is slow. A command palette (Mod+K) that searches every object in every connection, saved and recent queries, and every action is the fastest way around, and it makes every feature discoverable from the keyboard.

## What Changes

- Add the command palette from `design/canvas/CommandPalette.dc.html`: input, scope tabs (All / Objects / Queries / Actions), grouped results (TABLES & COLLECTIONS, SAVED & RECENT QUERIES, ACTIONS) with fuzzy match highlighting, per-result connection + env dot, keyboard footer.
- Add a background object index across connected (and previously connected) connections: tables, views, collections, Redis key prefixes, columns/fields.
- Result actions: Enter opens (table editor / collection / file), Alt+Enter opens in a console, Tab cycles scope.
- Recent files (Mod+E) as a palette preset.

## Capabilities

### New Capabilities
- `command-palette`: the palette UI, fuzzy search over objects / queries / actions, and the object index.

### Modified Capabilities
- (none)

## Impact

- Frontend: `src/features/palette/`; uses the shell's command registry.
- Rust: `palette_index` table in `clew.db` (connection, path, kind, name), refreshed on introspection; `palette_search` command with fuzzy scoring (`nucleo-matcher`).

## Context

The driver framework exposes `introspect_children(connection_id, path)`. This change builds the tree UI. Canvas: `design/canvas/Main.dc.html` (EXPLORER aside: 24px rows, 18px indent per level, uppercase group headers, badges, env dots, right-aligned dim detail, selected row `--bg-selected` with `inset 2px 0 0 var(--accent)`).

## Goals / Non-Goals

**Goals:** fast with thousands of tables; keyboard-first; no blocking of other work.
**Non-Goals:** cross-connection search (that's the command palette); editing schema objects (ALTER TABLE UI) in v1.

## Decisions

- **Flattened, virtualized tree.** Keep a normalized node map (`id → {node, childrenIds, state: idle|loading|loaded|error}`) and derive a flat list of visible rows; render with `@tanstack/react-virtual`. Expansion is O(visible).
- **Node ids** are stable paths: `<connId>/db:analytics/schema:public/group:tables/table:orders/col:id`. Persisted expansion state stores these ids in `ui_state` under `explorer.expanded`.
- **Request coalescing:** one in-flight request per node; Refresh cancels and replaces.
- **Row-count estimates** come from introspection; Count rows calls a driver `count_rows` (exact `SELECT count(*)`) on the metadata pool.
- **DDL generation** is driver-specific: PostgreSQL builds it from the catalogue (no `pg_dump` dependency); SQLite reads `sqlite_master.sql`.
- **Context menu** uses the shared `Menu` primitive; actions are registered in the command registry so the palette can reuse them.

## Risks / Trade-offs

- [Huge schemas (10k+ tables)] → virtualization plus a cap of 5,000 children rendered per group with a "Show all / filter" hint.
- [Estimates are stale] → label them as estimates in the tooltip ("≈12,480 rows · from statistics").

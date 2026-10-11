## Why

The most expensive mistake in a database tool is running the wrong statement against production. Clew treats production as a first-class state: clearly marked everywhere, read-only by default, and with guard rails around writes, so a tired programmer at 2 a.m. can't drop a table by accident.

## What Changes

- Enforce the per-connection safeguard flags set in the connection dialog: read-only by default, confirm writes, manual commit.
- Classify every statement before execution (read / write / DDL / unknown) per dialect.
- Read-only sessions: block writes in the UI and enforce at the database level where supported (`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, `SET SESSION TRANSACTION READ ONLY`, SQLite `query_only`).
- A toolbar badge and session toggle: "PRODUCTION · READ-ONLY" ↔ "PRODUCTION · READ-WRITE" (switching to read-write asks for confirmation and lasts for this session only).
- Write confirmation dialog listing the statements, target connection and an estimated affected-row count where cheap.
- Hard block of UPDATE/DELETE without WHERE and TRUNCATE/DROP on production unless the user types the connection name.
- Visual marking: red tab stripe, red env dot, red-tinted status bar segment, and red notice in the AI panel (`add-ai-assistant`).

Canvas screens implemented: the "PRODUCTION · READ-ONLY" badge in `Main.dc.html`, "PRODUCTION · WRITES NEED CONFIRMATION" in `DataGrid.dc.html`, the safeguards box in `ConnectionDialog.dc.html`.

## Capabilities

### New Capabilities
- `production-safeguards`: statement classification, read-only enforcement, write confirmation and dangerous-statement blocking.

### Modified Capabilities
- (none)

## Impact

- Rust: `src-tauri/src/safety/{classify.rs,guard.rs}`; `query_execute` and `changes_apply` call the guard first.
- Frontend: `src/features/safety/` (badge, toggle, confirm dialog, type-to-confirm dialog).
- Depends on `add-sql-console` and `add-data-grid`.

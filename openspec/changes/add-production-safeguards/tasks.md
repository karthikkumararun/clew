## 1. Classification

- [x] 1.1 Add `sqlparser` and implement `safety/classify.rs` per dialect with unknown→write (spec: production-safeguards › Statement classification)
- [x] 1.2 Detect missing WHERE on UPDATE/DELETE, TRUNCATE and DROP for the dangerous-statement rule
- [x] 1.3 Test: classification table covering CTEs, comments, EXPLAIN ANALYZE, CALL, multi-statement scripts

## 2. Guard and enforcement

- [x] 2.1 Implement `safety/guard.rs` decisions and statement-hash confirmation tokens; call it from `query_execute` and `changes_apply`
- [x] 2.2 Apply database-level read-only per driver when a session opens read-only (spec: production-safeguards › Read-only sessions)
- [x] 2.3 Session read-write toggle command (session-scoped, resets on close) (spec: production-safeguards › Session read-write toggle)
- [x] 2.4 Affected-row estimate via EXPLAIN with a 300 ms budget
- [x] 2.5 Test: blocked write never reaches the DB; token reuse for a different statement is rejected; PG read-only backstop

## 3. UI

- [x] 3.1 Toolbar badge (READ-ONLY / READ-WRITE) with toggle menu and confirmation
- [x] 3.2 Write confirmation dialog (connection + env, statements, row estimate; Cancel default) (spec: production-safeguards › Confirm writes)
- [x] 3.3 Type-the-name dialog for dangerous statements on production; warning dialog elsewhere (spec: production-safeguards › Dangerous statements)
- [x] 3.4 "Blocked: this session is read-only" output entry with "Switch to read-write" action; disable table-editor editing with reason
- [x] 3.5 Manual-commit defaults and quit/close/disconnect prompts (spec: production-safeguards › Manual commit)
- [x] 3.6 Production visibility audit: tree dot, chip, tab stripe, status bar tint (spec: production-safeguards › Production visibility)
- [x] 3.7 Test: Vitest flows for confirm, typed confirm and toggle

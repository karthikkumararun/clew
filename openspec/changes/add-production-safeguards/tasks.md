## 1. Classification

- [ ] 1.1 Add `sqlparser` and implement `safety/classify.rs` per dialect with unknown→write (spec: production-safeguards › Statement classification)
- [ ] 1.2 Detect missing WHERE on UPDATE/DELETE, TRUNCATE and DROP for the dangerous-statement rule
- [ ] 1.3 Test: classification table covering CTEs, comments, EXPLAIN ANALYZE, CALL, multi-statement scripts

## 2. Guard and enforcement

- [ ] 2.1 Implement `safety/guard.rs` decisions and statement-hash confirmation tokens; call it from `query_execute` and `changes_apply`
- [ ] 2.2 Apply database-level read-only per driver when a session opens read-only (spec: production-safeguards › Read-only sessions)
- [ ] 2.3 Session read-write toggle command (session-scoped, resets on close) (spec: production-safeguards › Session read-write toggle)
- [ ] 2.4 Affected-row estimate via EXPLAIN with a 300 ms budget
- [ ] 2.5 Test: blocked write never reaches the DB; token reuse for a different statement is rejected; PG read-only backstop

## 3. UI

- [ ] 3.1 Toolbar badge (READ-ONLY / READ-WRITE) with toggle menu and confirmation
- [ ] 3.2 Write confirmation dialog (connection + env, statements, row estimate; Cancel default) (spec: production-safeguards › Confirm writes)
- [ ] 3.3 Type-the-name dialog for dangerous statements on production; warning dialog elsewhere (spec: production-safeguards › Dangerous statements)
- [ ] 3.4 "Blocked: this session is read-only" output entry with "Switch to read-write" action; disable table-editor editing with reason
- [ ] 3.5 Manual-commit defaults and quit/close/disconnect prompts (spec: production-safeguards › Manual commit)
- [ ] 3.6 Production visibility audit: tree dot, chip, tab stripe, status bar tint (spec: production-safeguards › Production visibility)
- [ ] 3.7 Test: Vitest flows for confirm, typed confirm and toggle

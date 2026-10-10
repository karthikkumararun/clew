## Context

SQL drivers share one session contract; NoSQL stores need different operations. Canvas: `design/canvas/MongoBrowser.dc.html` (tree grid with Key/Value/Type columns, query bar fields, view switcher, Redis keys in the side list).

## Decisions

- **Family traits.** `DocumentSession` and `KeyValueSession` extend the base session; `DriverMeta.family` selects them. Results reuse `ResultEvent` with a `Documents(Vec<EJson>)` variant so streaming, paging and cancel work the same.
- **Relaxed shell syntax parsing** in Rust (`drivers/mongodb/shell_parse.rs`): a JSON5-like parser extended with `ObjectId`, `ISODate`, `NumberLong`, `NumberDecimal`, `UUID`, regex literals. No JavaScript engine: predictable and safe.
- **Explain for the index label:** after a find, run `explain("queryPlanner")` in the background (cheap) and report the winning plan's index or COLLSCAN.
- **Tree grid** reuses Glide Data Grid with a custom tree column (indent = 20px per depth, caret) so tree, table and grid share selection and copy behaviour.
- **Edits** use `replaceOne({_id, ...originalVersionCheck})` when the whole document is edited, `updateOne` with `$set`/`$unset` for field edits. The version check compares the edited fields' original values.
- **Redis** via `redis` crate `tokio-comp` + `tls-rustls`. SCAN with `COUNT 1000` and `TYPE` per key pipelined; TTL via `PTTL`. Command parsing for the console uses the server's `COMMAND DOCS` (Redis 7) for completion when available.
- **Safeguards** classification is extended: Mongo writes = insert/update/delete/drop/createIndex; Redis writes = commands flagged `write` in `COMMAND INFO`; `FLUSHDB/FLUSHALL/DEL` with patterns are "dangerous".

## Risks / Trade-offs

- [Users expect full mongosh JavaScript] → Explicitly out of scope; the error message explains the supported subset. Revisit with an embedded JS engine later.
- [SRV + SSH tunnel] → SRV resolves to multiple hosts; tunnelling them is unsupported in v1 (dialog disables SSH for SRV URIs).

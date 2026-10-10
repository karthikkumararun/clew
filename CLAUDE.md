# Clew — guide for coding agents

Clew ("by ADK") is an open-source DataGrip-style database IDE for macOS and Windows: Tauri 2 (Rust) + React 18 + TypeScript. SQL and NoSQL databases, a SQL console, data grid, and a bring-your-own-model AI assistant.

## Sources of truth

1. `openspec/changes/<change>/` — what to build: `proposal.md` (why), `specs/**/spec.md` (requirements + scenarios = acceptance tests), `design.md` (how), `tasks.md` (checklist).
2. `openspec/config.yaml` — project context: tech stack, repo layout, conventions. Don't substitute libraries without recording a decision in the change's `design.md`.
3. `design/` — the UX: `tokens.css` (all colors/sizes), `README.md` (visual language and metrics), `canvas/*.dc.html` (exact screens; read the inline styles and the sample data in each file's `<script>` block). Canvas: https://claude.ai/artifact/1JCzEuvKdjWPeHYcaTT3ku

## Build order

Implement one change at a time, in this order (each depends on the earlier ones):

1. `add-app-shell`
2. `add-driver-framework`  (PostgreSQL, MySQL/MariaDB, SQLite)
3. `add-connection-management`
4. `add-database-explorer`
5. `add-sql-console`
6. `add-data-grid`
7. `add-production-safeguards`
8. `add-more-sql-drivers`  (SQL Server, Oracle, ClickHouse, DuckDB)
9. `add-nosql-browser`
10. `add-command-palette`
11. `add-ai-assistant`  (resolve the Copilot open question in its design.md before task group 3)
12. `add-release-packaging`

## Workflow per change

- Start with `/opsx:apply <change>` (or `openspec instructions apply --change <change>`). Work through `tasks.md` in order and tick each `- [ ]` when done.
- Each task names the requirement it satisfies; each task group ends with tests. Turn the scenarios into the tests.
- Before calling a change done: `pnpm typecheck && pnpm lint && pnpm test`, `cargo fmt --check && cargo clippy -- -D warnings && cargo test` (in `src-tauri/`), and `openspec validate <change> --strict`.
- When a change is fully done, archive it with `/opsx:archive <change>` so its specs merge into `openspec/specs/`.
- If a spec is wrong or ambiguous, stop and update the change's spec/design (and say why) rather than silently diverging.

## Rules that matter

- UI: use only tokens from `src/styles/tokens.css`. No hard-coded hex, no emoji icons, no component libraries. Match canvas sizes (44px toolbar, 36px tabs, 24px tree rows, 26px grid rows, 28px buttons).
- Shortcuts: always via the shortcut registry with `Mod` (Cmd on macOS, Ctrl on Windows).
- Secrets (DB passwords, SSH passphrases, AI API keys) live only in the OS keychain: never in files, logs, IPC payloads to the WebView, or error messages.
- Network: only user-configured databases/SSH, user-configured AI endpoints, the consented Copilot download and the opt-in update check. No telemetry.
- AI never executes SQL. Production connections are read-only by default and AI sees schema only.
- Everything slow (connect, query, introspection, export, AI calls) is async and cancellable.
- Test on both macOS and Windows behaviour paths (CI runs both).

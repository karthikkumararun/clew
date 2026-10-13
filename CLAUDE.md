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
8. `add-app-icon`  (real app icon and in-app mark; independent, quick, can be built at any time)
9. `add-result-editing`  (edit query results in the console, paste, result tools; builds on the table editor)
10. `add-session-manager`  (Sessions panel, transactions, isolation level)
11. `add-e2e-testing`  (real-app end-to-end harness, seed data, release QA loop)
12. `add-more-sql-drivers`  (SQL Server, Oracle, ClickHouse, DuckDB)
13. `add-nosql-browser`
14. `add-graph-browser`  (Neo4j)
15. `add-command-palette`
16. `add-ai-assistant`  (resolve the Copilot open question in its design.md before task group 3)
17. `add-release-packaging`
18. `add-homebrew-packaging`  (brew install via the karthikkumararun tap; cask clears quarantine for the unsigned app; depends on release packaging)

## Workflow per change

- Start with `/opsx:apply <change>` (or `openspec instructions apply --change <change>`). Work through `tasks.md` in order and tick each `- [ ]` when done.
- Each task names the requirement it satisfies; each task group ends with tests. Turn the scenarios into the tests.
- Before calling a change done: `pnpm typecheck && pnpm lint && pnpm test`, `cargo fmt --check && cargo clippy -- -D warnings && cargo test` (in `src-tauri/`), and `openspec validate <change> --strict`.
- Changes after `add-e2e-testing` also end with an E2E task group: add or extend the journey that drives the real app and declare the covered scenarios (`covers('capability › Scenario')`). E2E suites run on `release/*` branches and nightly, not on PRs; locally use `pnpm qa:up`, `pnpm qa:e2e`, `pnpm qa:down` (see `docs/qa/README.md` once it exists).
- When a change is fully done, archive it with `/opsx:archive <change>` so its specs merge into `openspec/specs/`.
- Fixing a defect (branch `fix/<issue>-<slug>`): write the failing test first at the lowest level that can observe it (layout, visibility and clipping bugs need a real-render test, because jsdom cannot see them); if the behaviour was never specified, add the scenario to the spec; in the PR state the defect class and the guard that prevents the class (see `docs/qa/defect-classes.md` once it exists), or write "No automated test" with the reason.
- If a spec is wrong or ambiguous, stop and update the change's spec/design (and say why) rather than silently diverging.

## Rules that matter

- UI: use only tokens from `src/styles/tokens.css`. No hard-coded hex, no emoji icons, no component libraries. Match canvas sizes (44px toolbar, 36px tabs, 24px tree rows, 26px grid rows, 28px buttons).
- Shortcuts: always via the shortcut registry with `Mod` (Cmd on macOS, Ctrl on Windows).
- Secrets (DB passwords, SSH passphrases, AI API keys) live only in the OS keychain: never in files, logs, IPC payloads to the WebView, or error messages.
- Network: only user-configured databases/SSH, user-configured AI endpoints, the consented Copilot download and the opt-in update check. No telemetry.
- AI never executes SQL. Production connections are read-only by default and AI sees schema only.
- Everything slow (connect, query, introspection, export, AI calls) is async and cancellable.
- Test on both macOS and Windows behaviour paths (CI runs both).

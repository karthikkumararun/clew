## Why

Manual testing already found defects the automated tests could not: a toolbar clipped a dropdown menu and the sidebar toggle was missing once the sidebar was hidden in a wide window ([#24](https://github.com/karthikkumararun/clew/pull/24)); the explorer did not group by environment although the spec said so ([#25](https://github.com/karthikkumararun/clew/pull/25)). Component tests (jsdom) cannot see layout, the prose claim had no scenario, and the existing "default layout" test only checked that a token was declared. The plan below adds guards for those classes, not only for those two instances.

Clew's tests today stop short of the real thing. Component tests run against a mocked backend, and the Rust driver tests run against Docker databases without the UI. Nothing proves that a click in the real app window reaches the real Rust backend, a real database and comes back right, on both macOS and Windows. With 13 features and 12 databases, that gap will hide defects until users find them.

The plan for finding them: end-to-end suites that drive the built app against the full Docker stack, run on release branches and nightly (not every PR), plus a structured quality pass on the maintainer's machine after all features are built: run everything, report defects with a standard template, fix each with a regression test, repeat until a release gate is met.

## What Changes

- Add an end-to-end harness that launches the real built app (WebdriverIO with the Tauri service) in an isolated test mode (temporary data directory, file-backed secret store instead of the OS keychain, scripted file dialogs, no update checks), compiled only with a non-default `e2e` Cargo feature.
- Add a shared seed dataset (`shop` schema: users, orders, order_items, shipments, plus a 100k-row events table) loaded identically into every database, and a Docker Compose profile layout (`core`, `heavy`, `nosql`, `ai-mock`) including a deterministic mock LLM server.
- Add a journey catalogue (J-01…) covering the finished features first, with page objects keyed by accessible roles and labels, and a rule that every later change adds its journeys.
- Add two suites: **smoke** (real app + SQLite/DuckDB, no containers) on macOS, Windows and Linux; **full** (real app + Docker databases) on Linux; **nightly-heavy** for Oracle, SQL Server, ClickHouse and Neo4j.
- Run suites on `release/*` branches, nightly and by manual dispatch, not on every PR (PR CI keeps unit and integration tests).
- Add a **design-conformance** layer that checks the real app against the UX design: machine-readable metrics measured on rendered boxes, token lint, a state matrix covering every canvas screen, side-by-side canvas-vs-app review report (with an agent review prompt), per-platform visual baselines, a window-size and display-scale matrix and accessibility scans.
- Add generic guards for bug classes found by manual testing: an automatic overlay-integrity check on every menu, popover and dialog, a persisted-state sweep proving every hidden area has a way back, a test-level policy (layout scenarios need real rendering), and a spec-to-test completeness gate with a pre-implementation spec audit.
- Add scenario traceability: tests declare which spec scenarios they cover, a script checks those names exist and generates `docs/qa/coverage.md`.
- Add defect-class guards, a fix-PR check (regression test or documented reason), exploratory charters and a design-review step to the release gate.
- Add the missing requirements found by manual testing as spec deltas: `app-shell` (hidden areas can always be restored; overlays are fully visible) and `database-explorer` (default grouping by environment).
- Add a release QA loop for the maintainer's machine: `pnpm qa:up | qa:e2e | qa:checklist | qa:down`, a generated manual checklist for what can't be automated, an in-app "Copy diagnostics" button (redacted), a defect issue template with severities, fix rules (a failing regression test first) and a release gate.

## Capabilities

### New Capabilities
- `design-conformance`: metrics, token lint, state matrix, side-by-side review, visual baselines, overlay integrity, window-size and scale matrix, accessibility.
- `e2e-testing`: the real-app test harness, test mode, seed data and Docker stack, journeys, suites and triggers, failure artifacts, flake policy and traceability.
- `release-qa`: local one-command QA stack, manual checklist, diagnostics bundle, defect reporting, fix-and-verify loop and the release gate.

### Modified Capabilities
- `app-shell`: adds requirements that hidden areas can always be restored and that overlays are fully visible.
- `database-explorer`: adds the default grouping by environment requirement with scenarios.

## Impact

- New: `e2e/` (wdio config, specs, page objects, seed, helpers), `scripts/qa-*.ts`, `scripts/check-scenario-coverage.ts`, `docker/mock-llm/`, `docker/seed/`, `docs/qa/`, `.github/workflows/e2e.yml`, `.github/ISSUE_TEMPLATE/defect.yml`.
- Rust: `e2e` Cargo feature (test mode: data-dir override, file-backed secrets, dialog queue); `diagnostics_bundle` command.
- Frontend: About dialog gains "Copy diagnostics"; no other UI change.
- Dependencies (dev only): `@wdio/cli`, `@wdio/tauri-service`, `@wdio/mocha-framework`, `@wdio/spec-reporter`, `tsx`.
- `docker-compose.yml` gains profiles and services (mongo, redis, neo4j, mssql, oracle, clickhouse, mock-llm) as the matching drivers land.
- Config/docs: `openspec/config.yaml` task rules and `CLAUDE.md` workflow gain the end-to-end requirement.

## Why

Clew's tests today stop short of the real thing. Component tests run against a mocked backend, and the Rust driver tests run against Docker databases without the UI. Nothing proves that a click in the real app window reaches the real Rust backend, a real database and comes back right, on both macOS and Windows. With 13 features and 12 databases, that gap will hide defects until users find them.

The plan for finding them: end-to-end suites that drive the built app against the full Docker stack, run on release branches and nightly (not every PR), plus a structured quality pass on the maintainer's machine after all features are built: run everything, report defects with a standard template, fix each with a regression test, repeat until a release gate is met.

## What Changes

- Add an end-to-end harness that launches the real built app (WebdriverIO with the Tauri service) in an isolated test mode (temporary data directory, file-backed secret store instead of the OS keychain, scripted file dialogs, no update checks), compiled only with a non-default `e2e` Cargo feature.
- Add a shared seed dataset (`shop` schema: users, orders, order_items, shipments, plus a 100k-row events table) loaded identically into every database, and a Docker Compose profile layout (`core`, `heavy`, `nosql`, `ai-mock`) including a deterministic mock LLM server.
- Add a journey catalogue (J-01…) covering the finished features first, with page objects keyed by accessible roles and labels, and a rule that every later change adds its journeys.
- Add two suites: **smoke** (real app + SQLite/DuckDB, no containers) on macOS, Windows and Linux; **full** (real app + Docker databases) on Linux; **nightly-heavy** for Oracle, SQL Server, ClickHouse and Neo4j.
- Run suites on `release/*` branches, nightly and by manual dispatch, not on every PR (PR CI keeps unit and integration tests).
- Add scenario traceability: tests declare which spec scenarios they cover, a script checks those names exist and generates `docs/qa/coverage.md`.
- Add a release QA loop for the maintainer's machine: `pnpm qa:up | qa:e2e | qa:checklist | qa:down`, a generated manual checklist for what can't be automated, an in-app "Copy diagnostics" button (redacted), a defect issue template with severities, fix rules (a failing regression test first) and a release gate.

## Capabilities

### New Capabilities
- `e2e-testing`: the real-app test harness, test mode, seed data and Docker stack, journeys, suites and triggers, failure artifacts, flake policy and traceability.
- `release-qa`: local one-command QA stack, manual checklist, diagnostics bundle, defect reporting, fix-and-verify loop and the release gate.

### Modified Capabilities
- (none)

## Impact

- New: `e2e/` (wdio config, specs, page objects, seed, helpers), `scripts/qa-*.ts`, `scripts/check-scenario-coverage.ts`, `docker/mock-llm/`, `docker/seed/`, `docs/qa/`, `.github/workflows/e2e.yml`, `.github/ISSUE_TEMPLATE/defect.yml`.
- Rust: `e2e` Cargo feature (test mode: data-dir override, file-backed secrets, dialog queue); `diagnostics_bundle` command.
- Frontend: About dialog gains "Copy diagnostics"; no other UI change.
- Dependencies (dev only): `@wdio/cli`, `@wdio/tauri-service`, `@wdio/mocha-framework`, `@wdio/spec-reporter`, `tsx`.
- `docker-compose.yml` gains profiles and services (mongo, redis, neo4j, mssql, oracle, clickhouse, mock-llm) as the matching drivers land.
- Config/docs: `openspec/config.yaml` task rules and `CLAUDE.md` workflow gain the end-to-end requirement.

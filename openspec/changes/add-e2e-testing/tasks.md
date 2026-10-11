## 1. Spike and harness

- [ ] 1.1 Spike: with WebdriverIO and `@wdio/tauri-service` (embedded provider), launch the app, find by role, type, click, take a screenshot and relaunch with the same data dir on macOS, Windows and Linux; record versions and the outcome in design.md (spec: e2e-testing › Real-app end-to-end harness)
- [ ] 1.2 Add the `e2e` Cargo feature and test mode: `CLEW_DATA_DIR`, `FileSecretStore`, dialog queue, hard-disabled network extras, fixed clock (spec: e2e-testing › Isolated test mode)
- [ ] 1.3 CI check that release builds contain no test mode (feature tree + binary symbol grep) (spec: e2e-testing › Isolated test mode › Release build has no test mode)
- [ ] 1.4 Create `e2e/` with `wdio.conf.ts`, helpers (`launchApp`, `withDataDir`, `queueDialog`, `connectionFactory`, db clients) and a hello-world journey that passes on all three OSes
- [ ] 1.5 Test-mode accessible mirror for the canvas grid and the graph view (`data-testid` rows/nodes, only in `e2e` builds)

## 2. Seed data and Docker stack

- [ ] 2.1 Write the `shop` seed for PostgreSQL, MySQL, MariaDB and SQLite, including NULLs, Unicode, 30-digit decimals, JSON, zoned timestamps and the 100,000-row `events` generator (spec: e2e-testing › Shared seed dataset)
- [ ] 2.2 Restructure `docker-compose.yml` into profiles `core`, `nosql`, `heavy`, `ai-mock`; add health checks and fixed ports for each service that exists today (spec: e2e-testing › Docker stack)
- [ ] 2.3 Per-file isolation helpers (`CREATE DATABASE … TEMPLATE`, per-file schemas, copied template files) with automatic cleanup
- [ ] 2.4 Parity script comparing counts and sampled checksums across running databases (spec: e2e-testing › Shared seed dataset › Seed parity)
- [ ] 2.5 Mock LLM server in `docker/mock-llm/`: OpenAI- and Anthropic-compatible, streaming, scripted responses by marker, request log endpoint (spec: e2e-testing › Docker stack)
- [ ] 2.6 Test: parity script passes on PostgreSQL, MySQL, MariaDB and SQLite; stack starts only when all services are healthy

## 3. Page objects

- [ ] 3.1 Page objects by role and accessible name: Toolbar, Welcome, ConnectionDialog, Explorer, TabStrip, Console, ResultsPanel, Grid (via mirror), TableEditor, RecordPanel, PendingBar, ExportDialog, ImportExportDialog, SettingsDialog
- [ ] 3.2 Add missing accessible names or roles in the app where a page object needs a CSS selector (fix the app, not the test)

## 4. Journeys for finished features

- [ ] 4.1 J-01 first run to connected explorer; J-11 restart restores tabs, sidebar and explorer expansion
- [ ] 4.2 J-02 SSH bastion with key and verify-full TLS (including host-key prompt and changed-key refusal)
- [ ] 4.3 J-03 console run, multi-result script, error position underline, cancel, history; J-04 completion after snapshot
- [ ] 4.4 J-05 table editor edit/preview/submit/verify from a second connection, plus the changed-by-someone-else conflict; J-06 record panel navigation
- [ ] 4.5 J-07 export 100,000 rows with progress and cancel-deletes-partial-file
- [ ] 4.6 J-08 production safeguards flows (after `add-production-safeguards` is archived)
- [ ] 4.7 J-09 encrypted export/import including wrong passphrase and tampered file; J-10 DataGrip import from `e2e/fixtures/datagrip/`
- [ ] 4.8 J-12 cross-driver parity over PostgreSQL, MySQL, MariaDB and SQLite; J-13 keyboard-only operation
- [ ] 4.9 Each journey declares `covers('capability › Scenario')` for every spec scenario it exercises

## 5. Smoke suite on all platforms

- [ ] 5.1 Container-free smoke suite on SQLite/DuckDB: J-01, J-03, J-05 (SQLite), J-09, J-11 (spec: e2e-testing › Native platform smoke checks)
- [ ] 5.2 Real-keychain round trip with service name `Clew-e2e` and cleanup on macOS and Windows
- [ ] 5.3 Platform checks: title bar/toolbar layout, Mod shortcut mapping, paths with spaces and non-ASCII characters

## 6. CI

- [ ] 6.1 `.github/workflows/e2e.yml`: triggers `release/**` pushes, nightly schedule, manual dispatch with a suite input (spec: e2e-testing › Suites and triggers)
- [ ] 6.2 Jobs `smoke` (3-OS matrix, xvfb on Linux), `full` (core, nosql, ai-mock profiles), `heavy` (scheduled/dispatch)
- [ ] 6.3 Artifacts on failure (screenshot, app log, console log, Docker logs, step trace) with secret-free logs (spec: e2e-testing › Failure artifacts)
- [ ] 6.4 Retry-once and flaky summary; quarantine list and a script that opens the tracking issue (spec: e2e-testing › Flake policy)
- [ ] 6.5 Nightly failure creates or updates a single "Nightly e2e failing" issue
- [ ] 6.6 Confirm ordinary pull requests do not start the e2e workflow

## 7. Traceability

- [ ] 7.1 `covers()` helper for e2e; convention for Vitest names and Rust doc comments (spec: e2e-testing › Scenario traceability)
- [ ] 7.2 `scripts/check-scenario-coverage.ts` parsing `openspec/specs/**` and active changes; fail on dangling references; generate `docs/qa/coverage.md`
- [ ] 7.3 Backfill `(spec: …)` references in existing Vitest and Rust tests for the finished capabilities
- [ ] 7.4 Test: renamed-scenario fixture fails the check; report lists uncovered scenarios

## 8. Release QA

- [ ] 8.1 `scripts/qa-up.ts`, `qa-e2e.ts`, `qa-down.ts` with Docker checks, profile selection and skipped-journey listing; `pnpm qa:*` scripts (spec: release-qa › One-command local QA stack)
- [ ] 8.2 `scripts/qa-checklist.ts` generating `docs/qa/checklist.md` from uncovered and manual scenarios plus the fixed manual list; `docs/qa/runs/` convention (spec: release-qa › Manual QA checklist)
- [ ] 8.3 `diagnostics_bundle` command with redaction and the About dialog "Copy diagnostics" button (spec: release-qa › Diagnostics bundle)
- [ ] 8.4 `.github/ISSUE_TEMPLATE/defect.yml` with required fields, severity S1-S4 and labels; `spec` label flow (spec: release-qa › Defect reporting)
- [ ] 8.5 `docs/qa/README.md` (the loop) and `docs/qa/fix-prompt.md` (agent prompt for a defect); fix-branch naming and regression-test rule (spec: release-qa › Fix and verify loop)
- [ ] 8.6 `scripts/release-gate.ts` checking open S1/S2 issues, workflow results for the commit, checklist run files and coverage (spec: release-qa › Release gate)
- [ ] 8.7 Test: diagnostics redaction unit tests; gate script against fixture states

## 9. Process updates

- [x] 9.1 Add task rules to `openspec/config.yaml`: every change with user-visible behaviour ends with "E2E: add or extend journey J-nn" and lists the scenarios it covers
- [x] 9.2 Update `CLAUDE.md` workflow with the end-to-end requirement and the QA loop pointer
- [x] 9.3 Append an E2E task group to the unbuilt changes (`add-more-sql-drivers`, `add-nosql-browser`, `add-graph-browser`, `add-command-palette`, `add-ai-assistant`, `add-release-packaging`)

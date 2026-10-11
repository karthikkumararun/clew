## Context

Clew has component tests with a mocked IPC layer (Vitest), Rust driver tests against Docker databases (`cargo test --features integration`, Ubuntu CI job) and a CI matrix on macOS and Windows that builds and runs unit tests. The plan adds real-app end-to-end tests and a human quality pass. Hard constraints:

- GitHub's macOS and Windows runners cannot run Linux containers, so database-backed suites can only run on Linux CI; macOS and Windows get a container-free smoke suite.
- Tauri's official `tauri-driver` supports Windows and Linux only; macOS has no WKWebView driver tool ([Tauri WebDriver docs](https://v2.tauri.app/develop/tests/webdriver/)). The docs' recommended WebdriverIO service embeds a WebDriver server in the app so macOS works too.
- Native dialogs and the OS keychain cannot be driven through WebDriver.

## Lessons from manual testing (PRs #24 and #25)

| Defect | Why tests missed it | Class | Guard in this change |
|---|---|---|---|
| Toolbar `overflow: hidden` clipped the connection chip menu | jsdom does no layout; no test opened the menu in a real renderer | C1 invisible to jsdom | Overlay-integrity check on every popover in every journey; J-21 overlay sweep; window-size matrix |
| Sidebar toggle drawn only at narrow widths; hidden sidebar at wide width had no way back | Spec had Mod+B and the narrow case but not "hidden state persisted, wide window"; no test combined saved state with window size | C2 state with no way back | Spec requirement "Hidden areas can always be restored"; persisted-state sweep J-20 |
| Explorer ignored "default groups follow environment" | The claim lived in requirement prose; no scenario, so no test | C3 prose without scenario | Spec-to-test completeness gate and pre-implementation spec audit; new scenarios added here |
| Default layout "test" checked that `tokens.css` contains `36px` | The assertion looked at a token declaration, not rendered boxes | C5 weak test | Test-level policy; `design/metrics.json` measured on real boxes |
| PR #24 changed no test and no spec | No rule required it | C6 fix without regression test | Fix-PR check and defect-class field in the PR |

Measured on `main` at the time of writing: 41 component test files, only 2 refer to a spec scenario, none measure rendered layout, and no reference images of the canvas exist in the repository. The traceability and design-conformance work below closes those gaps.

## Goals / Non-Goals

**Goals:** drive the real built app on all three OSes; deterministic, isolated runs; one dataset across all databases; failures that are diagnosable from artifacts; a repeatable local QA loop with a release gate.
**Non-Goals:** per-PR end-to-end runs (cost); load/performance testing; pixel-diffing the app directly against the canvas render (engines and fonts differ, so the canvas is the human-reviewed reference and approved app screenshots become the baselines); mobile.

## Decisions

### Harness: WebdriverIO + `@wdio/tauri-service` (embedded provider), after a spike
The first task is a one-day spike proving: launch, find-by-role, type, click, screenshot, relaunch with the same data dir, on macOS, Windows and Linux. Outcomes: (a) embedded provider works everywhere, use it; (b) it works on two platforms, use `tauri-driver` on Windows/Linux and the embedded provider on macOS; (c) it does not work reliably on macOS, the macOS leg of smoke is reduced to a Rust-level check plus the manual checklist, and this decision is recorded here. The embedded WebDriver plugin is compiled only under the `e2e` feature.
Alternative considered: Playwright against the Vite dev server with a fake IPC. Rejected as the primary path because it does not exercise the Rust backend; kept as a possible fast layer for pure-UI journeys later.

### Test mode (`--features e2e`, env `CLEW_E2E=1`)
- `CLEW_DATA_DIR` overrides the app-data directory (settings, `connections.json`, `clew.db`, `ssh-keys/`).
- `secrets.rs` gains a `FileSecretStore` selected in test mode (JSON in the data dir; plaintext is acceptable because it only exists in test builds). The smoke suite alone uses the real keychain, with service name `Clew-e2e` and cleanup in `afterEach`.
- Dialog plugin wrapper reads `CLEW_E2E_DIALOG_QUEUE` (a file the test appends to) and returns the next path or cancel.
- Update checks and Copilot downloads are hard-disabled; `CLEW_E2E_NOW` fixes "x minutes ago" text.
- CI step `cargo tree -e features` plus a grep on the release binary asserts the feature is absent from release builds.

### Layout
```
e2e/
  wdio.conf.ts           # services, capabilities per OS, retries(1), reporters
  helpers/               # launchApp(), withDataDir(), queueDialog(), connectionFactory, db clients
  pages/                 # page objects: Toolbar, Explorer, Console, Grid, TableEditor, Dialogs...
  seed/                  # postgres.sql mysql.sql mariadb.sql sqlite.sql mssql.sql oracle.sql clickhouse.sql duckdb.sql mongo.js redis.txt neo4j.cypher
  specs/J-01-first-run.e2e.ts ...
  fixtures/datagrip/     # sample .idea and config folders for J-10
  coverage.json          # journey -> covered scenarios (also declared in tests)
```
Page objects locate by `role` and accessible name (the app already requires real buttons, labels and aria roles) and never by CSS classes, so styling changes do not break tests. A few canvas-only elements (the graph canvas, the glide grid) expose a hidden accessible mirror in test mode (`data-testid` rows) because canvas cells are not DOM.

### Seed and isolation
`shop` schema: `users(id, name, email NULL, plan, created_at timestamptz)`, `orders(id, user_id FK, status enum/varchar, total numeric(12,2), created_at, notes NULL)`, `order_items`, `shipments(order_id FK, carrier, shipped_at)`, and `events` with 100,000 generated rows. Values deliberately include NULL, Unicode, 30-digit decimals, JSON and zoned timestamps. A parity script (`e2e/helpers/parity.ts`) compares row counts and an MD5-of-sampled-columns across databases that are up.
Isolation: PostgreSQL `CREATE DATABASE … TEMPLATE shop_seed`; MySQL/MariaDB/SQL Server/Oracle/ClickHouse: create a per-file schema or database and run the seed script (small, fast; `events` is loaded by a server-side generator query); SQLite/DuckDB: copy a seeded template file; MongoDB: per-file database via `mongosh --eval` seed; Redis: per-file logical DB then `FLUSHDB`; Neo4j: per-file database on Enterprise images, otherwise label-prefixed data and cleanup (Community Edition has one database).

### Docker profiles
`core` (existing: postgres, postgres-tls, postgres-tls-wrong, mysql, mariadb, bastion), `nosql` (mongo:8 replica set single node, redis:7, neo4j:5), `heavy` (mssql 2022, oracle-free 23ai, clickhouse), `ai-mock`. The mock LLM (`docker/mock-llm/`, a ~150-line Node server) serves `/v1/chat/completions`, `/v1/messages` and `/v1/models`, returns scripted responses keyed by a marker in the prompt (for example `[[fix-carrier]]` returns the `edit_console` tool call that rewrites the console), supports streaming, and records requests so tests can assert what context was sent (schema only, no rows on production).

### CI
`.github/workflows/e2e.yml`: triggers `push: branches: ['release/**']`, `schedule` (nightly), `workflow_dispatch` with a suite input. Jobs: `smoke` (matrix macos-14, windows-latest, ubuntu-latest; builds with `--features e2e`; Linux uses `xvfb-run`), `full` (ubuntu-latest, compose profiles `core,nosql,ai-mock`), `heavy` (ubuntu-latest, `heavy` profile, scheduled and dispatch only because of image size). Cargo and pnpm caches; artifacts uploaded with `if: always()`. Nightly failure creates or updates one issue titled "Nightly e2e failing" via `gh issue`.

### Design-conformance layer
- **Metrics:** `design/metrics.json` (hand-maintained from `design/README.md`, validated against `tokens.css` by a script) maps region names to expected sizes. Components set `data-metric="toolbar"` (etc.) on their root elements, always on, no test-only code. `e2e/design/metrics.spec.ts` measures with `getBoundingClientRect` and `getComputedStyle` and compares at 1px tolerance.
- **Token lint:** stylelint `color-no-hex` / `declaration-property-value-disallowed-list` plus an ESLint rule for inline styles, allowing only `src/styles/tokens.css`; runs in the normal PR CI (cheap).
- **State matrix:** `design/states.json` lists states per canvas screen; `e2e/fixtures/states/<screen>-<state>/` holds connections JSON, UI state and the seed variant that reproduce the canvas sample data (connection names such as prod-postgres, staging-mysql, dev-mongo, cache-redis, notes.sqlite; the Ada Lovelace rows). States that need only static data (Welcome, dialogs, settings, empty explorer, disconnected trees) run on all three OSes without Docker; states that need live data (grid with rows, plan, graph) run on Linux with the stack.
- **Reference images:** `design/screens/<Screen>.png` exported from the canvas (Share › Export), committed once by the maintainer and refreshed whenever the canvas changes. They are the human reference, not a pixel-diff target.
- **Review report:** `pnpm qa:design` renders `e2e/artifacts/design/index.html` per state: reference | app | `pixelmatch` overlay | metric and token results. `docs/qa/design-review-prompt.md` is a prompt for a vision-capable agent to list discrepancies (missing elements, copy, spacing, colour, state) with proposed severities; the maintainer confirms before issues are filed.
- **Baselines:** approved screenshots live in `e2e/baselines/<platform>/<state>.png` (macOS, Windows, Linux differ in font rasterisation); compared with `pixelmatch` at 0.1% with masks for dynamic regions; updated only with `pnpm qa:design --update` and reviewed in the PR.
- **Matrix:** window sizes 1440×900, 1280×800, 1024×768, 880×700 and the minimum size; scale factors via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-device-scale-factor=1.25|1.5` on Windows and native Retina on macOS.
- **Accessibility:** `axe-core` injected per state (serious/critical fail), tab-order walk, focus-ring computed-style check.

### Overlay integrity helper
`e2e/helpers/overlay.ts` exports `expectOverlayIntact(el)`: box inside `window.innerWidth/innerHeight`; `document.elementFromPoint` at centre and four corners inset 4px resolves to the overlay or a descendant; walks `parentElement` chain flagging ancestors whose computed `overflow` is not `visible` and whose rect does not contain the overlay rect; presses Esc and asserts it closed and focus returned to the opener. Page-object methods `openMenu()`, `openDialog()`, `openPopover()` call it automatically, so no journey can open an overlay without the check.

### Spec-to-test completeness
`scripts/check-spec-completeness.ts` parses requirement prose: counts enumerated items (comma lists after a colon, parenthetical lists, "such as", "default", "for each", "every") and compares with the number of scenarios; flags requirements whose prose mentions defaults or lists but whose scenarios never mention the same nouns (simple token overlap, tuned on the explorer example). It is a screening aid with a ratchet file `docs/qa/known-gaps.json`; the definitive review is the agent spec audit (`docs/qa/spec-audit-prompt.md`), which maps every SHALL clause and list item to a scenario before a change moves to implementation.

### Traceability
Tests call `covers('connection-management › Test connection from the dialog')` (a helper that records the string and adds it to the test title). `scripts/check-scenario-coverage.ts` parses `#### Scenario:` headings under each `### Requirement:` in `openspec/specs/**` and active `openspec/changes/**/specs/**`, joins them with: e2e `covers(...)` declarations, Vitest `it('… (spec: capability › Scenario)')` names, and Rust test doc comments `/// spec: capability › Scenario`. Output: `docs/qa/coverage.md` and a non-zero exit for dangling references. It is informational for uncovered scenarios (they feed the manual checklist) and strict for dangling ones.

### Local QA loop
`scripts/qa-up.ts` checks Docker, runs `gen-test-certs.sh`, `docker compose --profile … up -d --build --wait`, then seeds. `scripts/qa-e2e.ts` builds the `e2e` app if the source hash changed, runs wdio with suite and journey filters, prints the summary and `e2e/artifacts/`. `scripts/qa-checklist.ts` writes `docs/qa/checklist.md`. `docs/qa/README.md` documents the loop: run suites → run checklist → file defects → fix with regression test → re-run → release gate. A `docs/qa/fix-prompt.md` gives the exact prompt to hand a defect issue to a coding agent ("read issue #N, find the spec scenario, write the failing test first…").

### Diagnostics bundle
Rust command `diagnostics_bundle()` assembles the report; a redaction pass replaces known hostnames and usernames from saved connections, anything matching secret patterns (`password=`, bearer tokens, `sk-…`, JDBC URL credentials) and file paths under the home directory. The About dialog button copies it with the Tauri clipboard plugin.

## Risks / Trade-offs

- [Embedded WebDriver on macOS may be immature] → The spike decides; fallback is a reduced macOS smoke plus manual checklist, recorded here.
- [Screenshot baselines are noisy across OS versions and fonts] → Per-platform baselines, bundled fonts only, masks for dynamic regions, 0.1% tolerance, review in PRs; the canvas comparison stays human or agent reviewed.
- [The spec-completeness heuristic misfires] → It only warns and ratchets; the agent audit and review are the real control.
- [Canvas-rendered grid and graph aren't in the DOM] → Test-mode accessible mirror; assertions read the mirror, screenshots cover the visual layer manually.
- [Flaky UI timing] → No fixed sleeps; wait on observable state (rows rendered, status text); one retry; quarantine policy.
- [Heavy images (Oracle ~1.5 GB, SQL Server ~2 GB RAM)] → Nightly and dispatch only; local maintainers choose profiles.
- [Test-mode code leaking into releases] → Cargo feature plus CI assertion on the release binary.
- [CI minutes on macOS/Windows] → Smoke is small (SQLite/DuckDB, ~15 journeys' worth of steps) and only on release branches and nightly.

## Open Questions

- Which exact `@wdio/tauri-service` provider and plugin versions pass the spike on all three OSes (decided during task 1.1).
- Whether Neo4j Community's single-database limit forces serial execution of graph journeys (likely yes).

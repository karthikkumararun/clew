# Clew — design hand-off

The UX for Clew was designed on a Claude Design canvas:
**https://claude.ai/artifact/1JCzEuvKdjWPeHYcaTT3ku** (private until shared from its Share menu).

This folder is the source of truth for implementation:

| File | What it is |
|---|---|
| `tokens.css` | Every color, font, size and radius. Copy to `src/styles/tokens.css`; components use only these variables. |
| `canvas/*.dc.html` | The exact source of each screen. Read the inline styles for spacing, sizes and copy. They are "Design Component" files: `{{name}}` holes and `<sc-for>` / `<sc-if>` are template syntax filled from the `<script>` block at the bottom (that block also holds the sample data). They do not open standalone in a browser. |
| `screens/` (optional) | PNG exports of the canvas (Share › Export on the canvas) for quick visual reference. |

## Screen index

| Screen | Canvas file | Implemented by change |
|---|---|---|
| Workspace: explorer + SQL console + results | `canvas/Main.dc.html` | `add-app-shell`, `add-database-explorer`, `add-sql-console`, `add-data-grid` |
| Table editor (data grid, pending changes, record panel) | `canvas/DataGrid.dc.html` | `add-data-grid` |
| Document browser (MongoDB) + Redis keys | `canvas/MongoBrowser.dc.html` | `add-nosql-browser` |
| Graph browser (Neo4j): Cypher editor, graph view, schema sidebar, inspector | `canvas/GraphBrowser.dc.html` | `add-graph-browser` |
| Welcome / first run | `canvas/Welcome.dc.html` | `add-app-shell`, `add-connection-management` |
| New connection dialog | `canvas/ConnectionDialog.dc.html` | `add-connection-management` |
| Command palette | `canvas/CommandPalette.dc.html` | `add-command-palette` |
| Import / export connections (encrypted export, DataGrip import with SQL consoles) | `canvas/ImportExport.dc.html` | `add-connection-management` |
| App icon (macOS, Windows, small sizes), in-app mark, dev-build badge | `canvas/AppIcon.dc.html` | `add-app-icon` |
| AI assistant side panel, inline diff review, Fix with AI | `canvas/AIAssistant.dc.html` | `add-ai-assistant` (panel slot: `add-app-shell`) |
| Settings › AI assistant (providers, sign-in, routing, privacy); also the layout for every Settings section | `canvas/AIProviders.dc.html` | `add-ai-assistant`, `add-app-shell` (Settings layout) |

## Visual language

- **Look:** dark, dense, quiet. A single gold accent (`--accent`) is the "thread": the primary button, the selected-row bar, the active tab underline, the sort arrow and the run marker. Nothing else is gold.
- **Type:** IBM Plex Sans 13px for UI; JetBrains Mono for anything a database produced or will consume (identifiers, values, SQL, URLs, paths). Section labels: 11px, uppercase, weight 600, letter-spacing 0.08em, `--text-muted`.
- **Environment colors:** every connection carries one (local green, dev blue, staging amber, production red). It shows as a dot in the tree, a 3px bar in recent lists, and a 2px top stripe on editor tabs. Production adds the red `PRODUCTION · READ-ONLY` badge in the toolbar.
- **Driver badges:** 20×14 rounded tags with a 2-letter code (`PG`, `MY`, `MA`, `MS`, `OR`, `CH`, `SQ`, `DK`, `MG`, `RD`, `N4`) on the driver color, dark text.
- **Typed values:** numbers `--syn-number`, strings `--syn-string`, dates `--syn-date`, booleans `--syn-boolean`, ObjectIds `--syn-objectid`, foreign keys underlined `--syn-link`, NULL as italic `NULL` in `--syn-null`.
- **Pending changes (grid):** edited cell = `--grid-edited-cell` + 1.5px inset accent ring; inserted row = `--grid-inserted-row`, `+` marker; deleted row = `--grid-deleted-row`, strikethrough, `−` marker; the amber pending bar sits at the bottom with Preview SQL / Revert all / Submit.
- **AI:** the AI uses the same gold accent with a four-point star icon. AI edits appear as an inline diff in the editor (removed = `--grid-deleted-row` + strikethrough + red left bar; added = `--grid-inserted-row` + green left bar; changed words on a stronger green), with per-hunk Keep/Undo and a floating amber review bar. AI never runs SQL.
- **Icons:** inline stroke SVGs, 12–16px, `currentColor`. No emoji, no icon fonts.
- **Density:** desktop-first. Controls are 28px high (below the 44px touch guideline on purpose; this is a keyboard-and-mouse tool). Every control is still a real `<button>`/`<input>` with a visible focus ring.

## App icon and mark

The brand mark is a golden ball of thread with its end trailing beneath it (a clew). Sources are in `design/icons/` and are the only source of truth: `clew-icon.svg` (macOS master), `clew-icon-windows.svg`, `clew-icon-small.svg` (sizes below 48 px, redrawn rather than scaled) and `clew-mark.svg` (one-colour mark for the toolbar and Welcome screen, takes `currentColor`). Never recolour, outline or add effects; keep 100 px clear on macOS and 48 px on Windows. The icon palette (ground `#1B2028` / `#0F1217` / `#14171C`, gold `#F2C070` / `#E3A64F` / `#C58633`) is documented on the canvas screen and is separate from the UI tokens.

## Layout metrics

| Element | Size |
|---|---|
| Title bar / main toolbar | 44px |
| Editor tab strip, result tab bar | 36px |
| Panel toolbars (grid, document) | 40px |
| Status bar | 26px |
| Explorer sidebar | 272px default, resizable 240–420px |
| Tree row | 24px, 18px indent per level |
| Grid row | 26px, header 2 lines (name + type) |
| SQL editor | 13px / 20px lines, 56px gutter |
| Dialog | max 960px wide, radius 12px; inputs 34px |
| Command palette | max 680px wide, 120px from top, 36px rows |
| AI side panel | 380px default, resizable 320–560px |
| Settings dialog | max 1120px wide; left section nav 200–210px |

## Things the canvas implies but doesn't show

- **Window chrome:** macOS uses an overlay title bar (traffic lights inset into the 44px toolbar, logo shifted right by 72px). Windows uses the native title bar above the 44px toolbar.
- **Empty states:** an explorer with no connections shows a "New connection" button and an "Import" link; an empty result shows "Statement executed · N rows affected · X ms" in the Output tab.
- **Errors:** query errors appear in the Output tab in `--danger`, with the error position underlined in the editor.
- **Focus:** a 2px `--accent` outline with a 2px offset on every focusable control.

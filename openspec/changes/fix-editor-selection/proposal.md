## Why

In the SQL console, selecting text does not work: dragging with the mouse, Cmd+Shift+Left from the end of a line, and Cmd+Shift+End/Home style selections produce no selection at all (reported on the Homebrew build of 0.1.0). Selection is required for copy, delete, Run selection, Format selection and Ask AI about the selection, so this blocks everyday use. The existing spec says what Run does with a selection but never states that the editor must let the user make one, which is how the defect went unguarded.

## What Changes

- Find the cause in the real app (the code uses CodeMirror's default keymap and `drawSelection()`, so the fault is in how events reach the editor or in the rendering layer, not in a missing binding) and fix it.
- Add the missing requirement and scenarios to `sql-console` so selection by mouse and by keyboard is specified and tested in a real render, which jsdom cannot see.
- Check the same behaviour in the other CodeMirror editors (value editor, Cypher/command editors, AI review) and cover them in the same test.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `sql-console`: add "Text selection" requirement.

## Impact

- Frontend: `src/features/console/editor/` (and the shared theme/extension wiring); no data or backend changes.
- Tests: a real-render test (Playwright-style or the E2E harness) for mouse drag, Shift+click, Shift+Arrow, Cmd/Ctrl+Shift+Left/Right, Shift+Home/End and Select all, plus a defect-class entry in `docs/qa/defect-classes.md`.

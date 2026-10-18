## Context

`Editor.tsx` builds CodeMirror 6 with `drawSelection()`, `rectangularSelection()`, `allowMultipleSelections`, `clickAddsSelectionRange` (Alt or Meta click adds a range) and the default keymap minus Mod+Enter and Escape. All the Shift+movement bindings are in that default keymap, so a missing binding is not the cause. The symptom (no selection forms at all, by mouse or keyboard) points to something outside CodeMirror's keymap: an event handler or a wrapper that swallows or resets the selection, or the selection layer not receiving the editor's state. The selection style itself (`theme.ts`) is fine.

## Approach

1. **Reproduce in the real app first** (jsdom has no selection or layout): run the E2E build, drive a drag and Shift+Arrow with real pointer and key events, and read `view.state.selection` through the test hook. This tells which layer loses it.
2. **Candidates, in order:** (a) the console's `onCursor` / `onChange` path or the `props.value` effect re-dispatching a full-document replacement on every update, which collapses the selection to the caret (the effect compares `doc.toString()` to `props.value`; any lag or normalisation difference replaces the document and resets the selection); (b) a statement-highlighting or run-marker extension that dispatches a selection; (c) `clickAddsSelectionRange` with `metaKey` interfering with Cmd+Shift key chords on macOS; (d) a global handler (shortcut registry or drag/drop) that calls `preventDefault` on pointer or Shift key events.
3. **Fix the cause, not the symptom**, and keep the fix in the shared editor setup so every CodeMirror editor benefits.
4. **Guard the class:** a real-render test that selects by mouse and by each keyboard chord in each editor kind, added to the E2E smoke suite, and a defect-class entry ("input handling that resets editor state") in `docs/qa/defect-classes.md`.

## Risks

- The defect may only reproduce in the packaged WebKit build (the reporter used the Homebrew install); the first task therefore confirms it against the release build as well as the E2E build.

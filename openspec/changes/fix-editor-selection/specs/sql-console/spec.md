## ADDED Requirements

### Requirement: Text selection
In every text editor of the app (SQL console, Cypher and command consoles, value editor, review editor), the user SHALL be able to select text with the mouse (drag, double-click for a word, triple-click for a line, Shift+click to extend) and with the keyboard (Shift+Arrow, Shift+Home/End, Mod+Shift+Left/Right to the line start/end on macOS, Ctrl+Shift+Home/End on Windows, Mod+A), and the selection SHALL be visible and usable by copy, cut, delete, Run selection and the other selection actions.

#### Scenario: Select with the mouse
- **WHEN** the user drags across `SELECT id, name FROM users` in the console
- **THEN** the dragged text is selected, highlighted, and Mod+C copies exactly that text

#### Scenario: Select to the line start
- **WHEN** the caret is at the end of a line and the user presses Mod+Shift+Left on macOS (Shift+Home on Windows)
- **THEN** the text from the caret back to the start of the line is selected

#### Scenario: Select to the line end
- **WHEN** the caret is at the start of a line and the user presses Mod+Shift+Right on macOS (Shift+End on Windows)
- **THEN** the text from the caret to the end of the line is selected

#### Scenario: Select to the document edges
- **WHEN** the user presses Mod+Shift+Down (macOS) or Ctrl+Shift+End (Windows)
- **THEN** everything from the caret to the end of the document is selected, and Mod+Shift+Up / Ctrl+Shift+Home selects to the start

#### Scenario: Selection runs
- **WHEN** text is selected by any of these means and the user presses Mod+Enter
- **THEN** exactly the selected text runs

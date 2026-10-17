# ai-inline-completion Specification

## Purpose
TBD - created by archiving change add-ai-assistant. Update Purpose after archive.
## Requirements
### Requirement: Ghost-text completions
When inline completions are enabled, the SQL editor SHALL show a suggestion as dim italic ghost text after the cursor (single or multi-line) after typing pauses (debounce 300 ms), with a small hint "Tab accept · ⌥] next · <provider>". Tab SHALL accept the whole suggestion, Mod+Right accept the next word, Alt+] / Alt+[ cycle alternatives, and Esc or any non-matching keystroke dismiss it. The schema completion popup SHALL take precedence over ghost text when both are present.

#### Scenario: Accept a suggestion
- **WHEN** the ghost text `AND o.status = 'shipped'` is shown and the user presses Tab
- **THEN** the text is inserted and the cursor moves to its end

#### Scenario: Typing through
- **WHEN** the user types characters that match the start of the ghost text
- **THEN** the suggestion stays and shrinks instead of being re-requested

#### Scenario: Popup open
- **WHEN** the schema completion popup is open
- **THEN** Tab picks the popup item, not the ghost text

### Requirement: Completion context and limits
Completion requests SHALL include the text before and after the cursor (up to 4,000 characters each), the dialect, and, within the data-sharing policy, the schema of tables referenced in the current statement. Requests SHALL be cancelled when the cursor moves or new text is typed, and SHALL not be sent for files over 1 MB or while the policy disables AI for the connection.

#### Scenario: Cancelled on typing
- **WHEN** the user keeps typing while a request is in flight
- **THEN** the in-flight request is cancelled and at most one new request is sent after the next pause

#### Scenario: Provider unavailable
- **WHEN** the completion provider errors three times in a row
- **THEN** completions pause for 60 seconds and the status bar shows "Completions: paused (provider error)"


## MODIFIED Requirements

### Requirement: Persisted workspace state
The system SHALL restore the window size and position, sidebar width and visibility, and the open tabs (with their editor contents) after a restart, by restoring the workspace that was active when the app quit (the built-in Last session workspace unless the user had switched to another).

#### Scenario: Restart restores tabs
- **WHEN** the user quits with three console tabs open and relaunches
- **THEN** the same three tabs reopen in the same order with the same text, without reconnecting until the user runs something

#### Scenario: Window off-screen
- **WHEN** the saved window position lies outside every current display
- **THEN** the window opens centered on the primary display

#### Scenario: Restart restores the active workspace
- **WHEN** the user quits while working in the named workspace "Release checklist" and relaunches
- **THEN** that workspace is active again with its tabs

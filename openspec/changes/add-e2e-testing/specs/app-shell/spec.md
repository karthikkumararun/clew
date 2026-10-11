## ADDED Requirements

### Requirement: Hidden areas can always be restored
For every area the user can hide, collapse or close (explorer sidebar, right side panel, results panel, record panel), the toolbar or the area's own header SHALL always show a visible control that restores it, at every window size and however the area came to be hidden: by shortcut, by its control, by a state saved from a previous launch, or by an automatic collapse. A shortcut SHALL never be the only way back.

#### Scenario: Sidebar hidden in a wide window
- **WHEN** the user hides the sidebar with Mod+B in a 1440px wide window and relaunches the app
- **THEN** the toolbar shows the sidebar toggle and clicking it restores the sidebar at its saved width

#### Scenario: Sidebar hidden by a saved state in a narrow window
- **WHEN** the app launches at 880px wide with the sidebar saved as visible
- **THEN** the sidebar is collapsed, the toolbar shows the sidebar toggle, and clicking it opens the sidebar as an overlay

#### Scenario: Closed side panel
- **WHEN** the user closes the right side panel
- **THEN** the control that opens it remains in the toolbar

#### Scenario: Every hidden state has an exit
- **WHEN** a test starts the app with each combination of saved layout state (sidebar shown or hidden, side panel open or closed, results panel collapsed) at 1440px and 880px wide
- **THEN** in every combination the control that restores each hidden area is visible and works

### Requirement: Overlays are fully visible
Every menu, popover, tooltip, completion list, context menu and dialog SHALL be fully visible inside the window and above neighbouring UI, never cut off by the container that opens it, and SHALL reposition to stay inside the window near its edges.

#### Scenario: Connection chip menu
- **WHEN** the user opens the toolbar connection chip's database and schema menu in a 1440px and an 880px wide window
- **THEN** the whole menu is visible, every item can be clicked and none is clipped by the toolbar

#### Scenario: Menu near the edge
- **WHEN** a menu opens near the right or bottom edge of the window
- **THEN** it opens in the direction that keeps all of it inside the window

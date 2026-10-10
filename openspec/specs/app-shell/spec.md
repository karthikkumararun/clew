# app-shell Specification

## Purpose
TBD - created by archiving change add-app-shell. Update Purpose after archive.
## Requirements
### Requirement: Desktop application on macOS and Windows
The system SHALL run as a native desktop application on macOS 12+ (Apple Silicon and Intel) and Windows 10/11 x64, in a single main window titled "Clew".

#### Scenario: Launch on macOS
- **WHEN** the user launches Clew on macOS
- **THEN** a window opens with an overlay title bar whose traffic-light buttons sit inside the 44px main toolbar, and the Clew logo is offset so it does not overlap them

#### Scenario: Launch on Windows
- **WHEN** the user launches Clew on Windows
- **THEN** a window opens with the native title bar above the 44px main toolbar

#### Scenario: Missing WebView2 on Windows
- **WHEN** Clew is installed on a Windows machine without the WebView2 runtime
- **THEN** the installer installs the runtime (or bootstraps it) before first launch

### Requirement: Workspace layout
The system SHALL present the workspace as: a main toolbar at the top, a resizable explorer sidebar on the left, an editor area with a tab strip in the middle, an optional resizable side panel on the right (used by the AI assistant), and a status bar at the bottom, matching `design/canvas/Main.dc.html` and `design/canvas/AIAssistant.dc.html`.

#### Scenario: Default layout
- **WHEN** the app starts for the first time
- **THEN** the sidebar is 272px wide, the toolbar is 44px tall, the tab strip is 36px tall and the status bar is 26px tall

#### Scenario: Resize the sidebar
- **WHEN** the user drags the sidebar's right edge
- **THEN** the sidebar width follows the pointer within 240px–420px, and the width is restored on the next launch

#### Scenario: Toggle the sidebar
- **WHEN** the user presses Mod+B
- **THEN** the sidebar collapses or expands, and the editor area takes the freed space

#### Scenario: Right side panel
- **WHEN** a feature opens the right side panel
- **THEN** the panel appears at 380px wide (resizable 320–560px), the editor area shrinks to make room, and the panel's open state and width are restored on the next launch

#### Scenario: Narrow window
- **WHEN** the window is narrower than 900px
- **THEN** the sidebar collapses automatically and can be opened as an overlay

### Requirement: Brand mark in the toolbar
The main toolbar SHALL show the Clew thread-ball logo in the accent color, followed by the wordmark "Clew" with "by ADK" beneath it in small accent-colored type.

#### Scenario: Toolbar brand
- **WHEN** the workspace is visible
- **THEN** the top-left of the toolbar shows the logo, "Clew" and "by ADK" as in the canvas

### Requirement: Editor tabs
The system SHALL host open editors (consoles, table editors, document browsers, files) as tabs in the editor area. Each tab SHALL show an icon, a title, an optional subtitle (connection name), an optional dirty marker and a close button. A tab bound to a connection SHALL show a 2px top stripe in that connection's environment color.

#### Scenario: Open and focus
- **WHEN** a feature opens an editor that is already open (same kind and same target)
- **THEN** the existing tab is focused instead of opening a duplicate

#### Scenario: Close tab
- **WHEN** the user clicks a tab's close button or presses Mod+W
- **THEN** the tab closes and the tab to its left (or the first remaining tab) becomes active

#### Scenario: Close a tab with unsaved changes
- **WHEN** the user closes a tab whose editor reports unsaved changes
- **THEN** the system asks "Save", "Discard" or "Cancel" before closing

#### Scenario: Reorder and switch
- **WHEN** the user drags a tab to a new position, or presses Mod+Shift+] / Mod+Shift+[
- **THEN** the tab moves to that position, or the next/previous tab is activated

#### Scenario: Overflow
- **WHEN** the open tabs do not fit in the strip
- **THEN** the strip scrolls horizontally and keeps the active tab in view

#### Scenario: Production stripe
- **WHEN** a tab belongs to a connection whose environment is Production
- **THEN** the tab shows a red (`--env-prod`) 2px top stripe

### Requirement: Welcome screen
When no editor tabs are open, the editor area SHALL show the Welcome screen from `design/canvas/Welcome.dc.html`: logo, "Clew", "by ADK", a one-line description, actions (New connection, Import connections, Open a database file), a connection-URL field, a Recent list, shortcut hints and a footer with the real connections-file location and app version.

#### Scenario: First run
- **WHEN** the app starts with no saved connections and no open tabs
- **THEN** the Welcome screen is shown and the Recent list shows "No connections yet"

#### Scenario: Last tab closed
- **WHEN** the user closes the last open tab
- **THEN** the Welcome screen is shown

#### Scenario: Footer path is real
- **WHEN** the Welcome screen renders
- **THEN** the footer shows the actual platform path of the connections file (for example `~/Library/Application Support/Clew/connections.json` on macOS or `%APPDATA%\Clew\connections.json` on Windows)

### Requirement: Keyboard shortcuts
The system SHALL provide a central shortcut registry where `Mod` means Cmd on macOS and Ctrl on Windows. Shortcut hints shown in the UI SHALL render with the platform's symbols (⌘⇧⌥ on macOS, Ctrl+Shift+Alt on Windows).

#### Scenario: Platform mapping
- **WHEN** a feature registers the shortcut "Mod+K"
- **THEN** it fires on Cmd+K on macOS and Ctrl+K on Windows, and hints read "⌘K" and "Ctrl+K" respectively

#### Scenario: Conflict detection
- **WHEN** two features register the same shortcut in the same scope
- **THEN** the registry rejects the second registration and logs an error in development builds

#### Scenario: Editor-scoped shortcuts
- **WHEN** focus is inside a text editor and the user presses a shortcut that the editor handles (for example Mod+/ to comment)
- **THEN** the editor's handler wins over a global handler with the same keys

### Requirement: Settings
The system SHALL provide a Settings dialog (Mod+,) laid out like `design/canvas/AIProviders.dc.html` (left section nav: General, Editor, Data grid, Keymap, AI assistant, Updates; later changes fill their sections) with at least: editor font size (11–20, default 13), grid row page size (100/500/1000, default 500), confirm before closing a tab with unsaved changes (default on), check for updates (default off). Settings SHALL persist across restarts and apply immediately.

#### Scenario: Change editor font size
- **WHEN** the user sets the editor font size to 15
- **THEN** all open SQL editors re-render at 15px without a restart

#### Scenario: Corrupt settings file
- **WHEN** the settings file cannot be parsed at startup
- **THEN** the app starts with defaults, keeps a backup of the bad file, and shows a non-blocking notice

### Requirement: Persisted workspace state
The system SHALL restore the window size and position, sidebar width and visibility, and the list of open tabs (with their editor contents) after a restart.

#### Scenario: Restart restores tabs
- **WHEN** the user quits with three console tabs open and relaunches
- **THEN** the same three tabs reopen in the same order with the same text, without reconnecting until the user runs something

#### Scenario: Window off-screen
- **WHEN** the saved window position lies outside every current display
- **THEN** the window opens centered on the primary display

### Requirement: Status bar
The status bar SHALL show, on the left, the active tab's connection state (dot + "Connected · <name>" or "Disconnected"), server version and transport (e.g. "via SSH bastion"), and on the right, context items supplied by the active editor (cursor position, encoding, dialect).

#### Scenario: No active connection
- **WHEN** the Welcome screen is showing
- **THEN** the status bar shows only the app version on the right

### Requirement: Offline by default
The application SHALL make no network requests other than: database connections and SSH tunnels the user configured, AI provider endpoints the user configured (and the one-time, consented download of GitHub's Copilot component), and the opt-in update check. Fonts and all assets SHALL be bundled.

#### Scenario: No telemetry
- **WHEN** the app runs with default settings and no AI provider configured
- **THEN** no HTTP request leaves the machine


## ADDED Requirements

### Requirement: Assistant side panel
The toolbar SHALL show an "AI" toggle (Mod+I) that opens the assistant in the right side panel, matching `design/canvas/AIAssistant.dc.html`: header "AI ASSISTANT" with Chat / History tabs, New chat and Close; a red production notice ("Production: AI never runs SQL. Schema only, no row data.") when the active tab is a production connection; the message list; and the composer.

#### Scenario: Toggle
- **WHEN** the user presses Mod+I
- **THEN** the panel opens focused on the composer, or closes if open

#### Scenario: No provider
- **WHEN** the panel opens and no chat provider is configured
- **THEN** it shows "Connect a model to start" with a button to Settings › AI assistant

### Requirement: Composer
The composer SHALL contain: context chips (active connection with env dot, @-mentioned tables, attached selection/error/results, "+ context"), a multi-line input with placeholder "Ask about <connection>…  @ to mention a table, / for commands", an Ask / Edit mode switch, a model picker on one line (e.g. "● Sonnet 5.5 ▾"), and a Send button. Enter sends, Shift+Enter inserts a newline.

#### Scenario: Mention a table
- **WHEN** the user types `@ord` and picks `orders`
- **THEN** an `@orders` chip is added and that table's schema is included as context

#### Scenario: Slash command
- **WHEN** the user types `/optimize` with a statement selected
- **THEN** the request asks the model to optimize that statement, attaching its EXPLAIN plan text if one was produced in this console

### Requirement: Streaming answers
Assistant replies SHALL stream token by token with a header line naming the model and the context it read (e.g. "Claude Sonnet 5.5 · read schema of orders, shipments"), render Markdown with highlighted SQL code blocks (each with Copy and "Insert at cursor"), and offer follow-up suggestion chips when the model provides them. The user SHALL be able to stop a reply mid-stream.

#### Scenario: Stop
- **WHEN** the user presses Stop (or Esc in the composer) while a reply streams
- **THEN** streaming stops and the partial reply is kept, marked "Stopped"

#### Scenario: Provider error
- **WHEN** the provider returns a rate-limit or network error
- **THEN** the message shows the error with Retry, and the composer keeps the user's text

### Requirement: Ask and Edit modes
In Ask mode the assistant SHALL only answer. In Edit mode the assistant SHALL be allowed to change the active console's text; it SHALL NOT be able to execute any statement in either mode.

#### Scenario: Ask mode suggestion
- **WHEN** the user asks for a query in Ask mode
- **THEN** the reply contains the SQL as a code block and the editor is not touched

#### Scenario: Edit mode without a console
- **WHEN** Edit mode is on and the active tab is not a console
- **THEN** the assistant creates a new console for the active connection and writes there

### Requirement: Direct edits with review
In Edit mode, the assistant's changes SHALL be applied directly to the editor as a pending inline diff: removed lines on `--grid-deleted-row`-style red background with strikethrough and a red left bar, added lines on green background with a green left bar, changed words highlighted, gutter line numbers tinted. Each change hunk SHALL have Keep and Undo buttons. A floating review bar SHALL show "AI edited <n> hunks", "+<added> −<removed>", previous/next hunk navigation with "<i> / <n>", "Undo all" (Mod+Backspace) and "Keep all" (Mod+Enter). The chat SHALL show an "Edited <tab name>" card with +/− counts, a "Pending review" status, the list of changes by line, and Keep all / Undo all / Jump to changes.

#### Scenario: Fix applied as a diff
- **WHEN** the user asks "Fix the error and explain why it happened" in Edit mode
- **THEN** the corrected statement appears in the editor as a diff, the review bar shows the hunk count, and nothing has run

#### Scenario: Keep one, undo another
- **WHEN** the user keeps hunk 1 and undoes hunk 2
- **THEN** the editor contains hunk 1's new text and hunk 2's original text, and the card shows "1 kept · 1 undone"

#### Scenario: User types during review
- **WHEN** the user edits text outside the pending hunks while review is open
- **THEN** the hunks stay pending and their positions follow the edit

#### Scenario: Run with pending AI edits
- **WHEN** the user presses Run while AI hunks are still pending
- **THEN** the system asks "Keep all and run" / "Run original" / "Cancel"

#### Scenario: Undo after keep
- **WHEN** the user presses Mod+Z right after Keep all
- **THEN** the whole AI edit is undone in one step

### Requirement: Fix and explain errors
When a statement fails, the Output tab SHALL show "Fix with AI" and "Explain error" buttons. "Fix with AI" SHALL open the panel in Edit mode with the statement and error attached and send a fix request; "Explain error" SHALL do the same in Ask mode.

#### Scenario: Fix with AI
- **WHEN** the user clicks Fix with AI on `column o.carrier does not exist`
- **THEN** the panel opens with chips "console · lines 2–5" and "error", the request is sent, and the fix arrives as a reviewable diff

### Requirement: Schema-grounded context
For every request the system SHALL include, within the data-sharing policy: the connection's dialect and server version, the schema of mentioned tables and of tables referenced by the current statement (columns, types, keys, indexes), the current statement or selection, and the last error. The model SHALL be able to ask for more schema through read-only tools (`list_tables`, `describe_table`) that return only schema, never rows.

#### Scenario: Model asks for another table
- **WHEN** the model calls `describe_table("shipments")`
- **THEN** Clew returns that table's schema, and the reply header lists `shipments` as read

#### Scenario: No row access
- **WHEN** a model tries any tool other than the schema tools
- **THEN** the request is refused and the model is told only schema tools exist

### Requirement: Chat history
The History tab SHALL list past chats per connection with their first message and date, reopen them, and allow deleting one or all. Chats SHALL be stored locally only.

#### Scenario: Reopen a chat
- **WHEN** the user opens yesterday's chat from History
- **THEN** the conversation is restored and new messages continue it

### Requirement: AI status in the status bar
The status bar SHALL show the AI state on the right: completions provider and state (e.g. "Copilot: completions on") and the chat model (e.g. "Chat: Claude Sonnet 5.5"), each opening the AI settings when clicked.

#### Scenario: Completions off
- **WHEN** inline completions are routed to Off
- **THEN** the status item reads "Completions: off"

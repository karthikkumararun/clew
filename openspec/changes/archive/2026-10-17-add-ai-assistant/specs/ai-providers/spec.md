## ADDED Requirements

### Requirement: AI settings page
Settings SHALL have an "AI assistant" section matching `design/canvas/AIProviders.dc.html`: a master "Enable AI features" switch (default off until a provider is set up), a PROVIDERS list (GitHub Copilot, Anthropic Claude, OpenAI, Custom endpoint, Local model) each with a status ("Signed in", "Connected", "Not set up", "Waiting…"), a detail panel for the selected provider, a USE FOR routing table and a WHAT THE AI CAN SEE section.

#### Scenario: Fresh install
- **WHEN** the user opens Settings › AI assistant for the first time
- **THEN** every provider shows "Not set up", AI features are off, and no AI request has been made

### Requirement: GitHub Copilot sign-in
The system SHALL sign in to GitHub Copilot with GitHub's device flow: show the one-time code in large mono type with "Copy & open browser" (opens github.com/login/device), a waiting state with the expiry countdown, "Check now" and Cancel; on success show "Signed in as @<login>" and the detected Copilot plan, with Sign out. Clew SHALL never ask for the GitHub password.

#### Scenario: Successful sign-in
- **WHEN** the user clicks "Sign in with GitHub", enters the code on github.com and authorizes
- **THEN** within a few seconds the provider shows "Signed in as @<login>" and inline completions become available

#### Scenario: No Copilot subscription
- **WHEN** the GitHub account has no active Copilot access
- **THEN** the panel shows "This GitHub account doesn't have Copilot access" and the provider stays unusable

#### Scenario: Code expired
- **WHEN** the device code expires before authorization
- **THEN** the panel returns to signed-out with "The code expired — try again"

#### Scenario: Component download consent
- **WHEN** the user signs in to Copilot for the first time
- **THEN** Clew explains that it needs to download GitHub's Copilot component (with its size), downloads it only after the user agrees, verifies its checksum and stores it in the app-data directory

### Requirement: API-key providers
Anthropic Claude and OpenAI SHALL be configured with an API key (masked input, Paste button, "Where do I get a key?" link), a chat model chosen from the provider's model list, and an optional base URL (defaults `https://api.anthropic.com` and `https://api.openai.com/v1`). Keys SHALL be stored only in the OS keychain.

#### Scenario: Model list
- **WHEN** a valid key is saved
- **THEN** the model dropdown is filled from the provider's models endpoint, with Claude defaulting to `claude-sonnet-5-5`

#### Scenario: Invalid key
- **WHEN** the provider rejects the key on Test connection
- **THEN** the panel shows "The API key was rejected (401)" and the provider status stays "Not set up"

### Requirement: Custom endpoint
The user SHALL be able to add one or more custom endpoints with display name, API style (OpenAI-compatible chat/completions, or Anthropic-compatible messages), base URL, authentication (Bearer token, custom header name + value, or none), model id and optional extra headers.

#### Scenario: Company gateway
- **WHEN** the user adds "Team gateway" with an OpenAI-compatible base URL and bearer token and presses Test connection
- **THEN** Clew sends a minimal chat request and shows "Reachable · model responded in <ms> ms"

#### Scenario: Plain HTTP
- **WHEN** the base URL uses `http://` and is not localhost
- **THEN** the form warns that the token would be sent unencrypted and requires confirmation to save

### Requirement: Local model
The user SHALL be able to point Clew at a local OpenAI-compatible server (default `http://localhost:11434` for Ollama), with the model list detected from the server.

#### Scenario: Server not running
- **WHEN** the local endpoint refuses the connection
- **THEN** Test connection shows "Nothing is listening on localhost:11434 — is Ollama running?"

### Requirement: Feature routing
The USE FOR table SHALL let the user pick a provider/model for: Inline completions (Copilot, another configured provider that supports fill-in-the-middle, or Off), Chat panel, Fix / explain errors (default "Same as chat"), and Natural language → SQL (default "Same as chat"). Only configured providers SHALL be selectable.

#### Scenario: Provider removed
- **WHEN** the user signs out of Copilot while it is routed to inline completions
- **THEN** inline completions switch to Off and the routing row says so

### Requirement: Data-sharing policy
The WHAT THE AI CAN SEE section SHALL control what leaves the machine: schema (table, column, index names and types; default on), editor SQL and error messages (default on), sample rows from results (default off; only rows the user explicitly attaches, max 20), and a Production policy: "Schema only, never row data" (default), "Disable AI entirely", or "Same as other connections". Hostnames, usernames, passwords and connection strings SHALL never be sent.

#### Scenario: Production schema-only
- **WHEN** the active connection is Production with the default policy and the user attaches result rows to a message
- **THEN** the attachment is refused with "Row data isn't shared for Production connections"

#### Scenario: AI disabled on production
- **WHEN** the policy is "Disable AI entirely" and the active tab is a production console
- **THEN** inline completions stop, and the panel shows "AI is off for Production connections"

#### Scenario: What was sent
- **WHEN** the user expands "Context sent" on any assistant message
- **THEN** the exact context items sent with that request are listed

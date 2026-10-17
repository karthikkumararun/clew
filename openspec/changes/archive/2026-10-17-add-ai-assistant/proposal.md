## Why

Programmers now expect AI help in their tools: completions as they type, explaining or fixing a failing query, turning a sentence into SQL that knows the real schema. JetBrains has an AI side panel; Clew should too, but bring-your-own-model (GitHub Copilot, Claude, OpenAI/Codex, any compatible endpoint or a local model), with privacy controls that suit production databases.

## What Changes

- Add AI provider configuration in Settings › AI assistant (`design/canvas/AIProviders.dc.html`): GitHub Copilot (GitHub device-code sign-in), Anthropic Claude (API key), OpenAI (API key; GPT and Codex models), Custom endpoint (OpenAI- or Anthropic-compatible: base URL, auth, model id), Local model (Ollama / LM Studio); Test connection; per-feature routing ("Use for"); data-sharing controls ("What the AI can see").
- Add the AI assistant side panel (`design/canvas/AIAssistant.dc.html`), toggled with Mod+I: Chat / History, a production notice, a message list with context chips, streamed answers, follow-up suggestion chips, and a composer with @-mentions of tables, slash commands (/explain, /fix, /optimize, /generate), Ask / Edit mode and a model picker.
- Add **direct edits with review**: in Edit mode the assistant writes into the active console as an inline diff (removed lines red and struck through, added lines green, changed words highlighted), with per-change Keep / Undo, a floating review bar (count, +/−, previous/next, Undo all Mod+Backspace, Keep all Mod+Enter) and an "Edited …" card in the chat. AI never runs SQL.
- Add "Fix with AI" (Mod+Alt+F) and "Explain error" on query errors in the Output tab.
- Add inline ghost-text completions in the SQL editor (Copilot or another provider), Tab to accept, Alt+] for next suggestion.

Canvas screens implemented: `design/canvas/AIAssistant.dc.html`, `design/canvas/AIProviders.dc.html`, and the AI toggle button in the toolbar.

## Capabilities

### New Capabilities
- `ai-providers`: provider setup and sign-in, secrets, model discovery, per-feature routing and data-sharing policy.
- `ai-assistant`: the side panel chat, context handling, Ask/Edit modes, direct edits with review, and error fixing.
- `ai-inline-completion`: ghost-text completions in the SQL editor.

### Modified Capabilities
- (none; the `app-shell` "Offline by default" requirement already allows user-configured AI endpoints)

## Impact

- Rust: `src-tauri/src/ai/{providers/,copilot/,context.rs,policy.rs,chat.rs}`; streaming over Channels; keychain for API keys.
- Frontend: `src/features/ai/` (SidePanel content, Composer, MessageList, EditCard, ReviewBar, settings page), CodeMirror extensions for inline completion and the review diff (`@codemirror/merge` unified view).
- Dependencies: `reqwest` (rustls, stream), `eventsource-stream`, `tower-lsp`-style JSON-RPC client (or `lsp-types` + hand-rolled stdio framing) for Copilot, `@codemirror/merge`.
- Network: requests go only to endpoints the user configured; nothing is sent until a provider is set up and AI is enabled.
- Depends on `add-sql-console`, `add-connection-management` and `add-production-safeguards` (production policy).

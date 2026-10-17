## 1. Provider layer (Rust)

- [ ] 1.1 Define `ChatProvider`, `CompletionProvider`, `ChatRequest`, `ChatEvent` (text delta, tool call, done, error) and provider config model with keychain-backed secrets (spec: ai-providers › API-key providers)
- [ ] 1.2 Anthropic provider: models list, streaming Messages API with tool use, error mapping (401, 429, 5xx)
- [ ] 1.3 OpenAI provider: models list, streaming chat completions with tools; reuse for OpenAI-compatible custom endpoints and Local model (spec: ai-providers › Custom endpoint, Local model)
- [ ] 1.4 Anthropic-compatible custom endpoint (base URL + auth header variants); plain-HTTP warning
- [ ] 1.5 `ai_test_provider` command (minimal request, latency) and `ai_models` command
- [ ] 1.6 Test: SSE parsing fixtures for both APIs; keys never appear in logs or IPC payloads

## 2. Settings › AI assistant (frontend)

- [ ] 2.1 Settings section layout per `AIProviders.dc.html`: enable switch, provider list with statuses, detail panel (spec: ai-providers › AI settings page)
- [ ] 2.2 Key forms for Anthropic and OpenAI (masked key, Paste, model select, base URL), Custom endpoint form, Local model form, Test connection + Save
- [ ] 2.3 USE FOR routing table limited to configured providers; auto-Off when a provider is removed (spec: ai-providers › Feature routing)
- [ ] 2.4 WHAT THE AI CAN SEE controls and production policy select (spec: ai-providers › Data-sharing policy)
- [ ] 2.5 Test: Vitest for form validation, routing fallback and policy persistence

## 3. GitHub Copilot

- [ ] 3.1 Resolve the licensing open question in design.md; stop and report if the terms don't allow this
- [ ] 3.2 Consent dialog, download pinned `@github/copilot-language-server`, verify sha512 integrity, unpack to app data (spec: ai-providers › GitHub Copilot sign-in)
- [ ] 3.3 Launch the server (native binary or Node on PATH) and implement the JSON-RPC stdio client
- [ ] 3.4 Device-flow sign-in UI states (code, copy & open browser, countdown, check now, cancel, signed in as, sign out, no-access and expired errors)
- [ ] 3.5 Copilot `CompletionProvider` via inline completion requests on a mirrored virtual document
- [ ] 3.6 Test: JSON-RPC framing; sign-in state machine with a fake server

## 4. Context and policy

- [ ] 4.1 `ContextBuilder`: dialect, version, mentioned + referenced tables (sqlparser), statement/selection, last error, attached rows (spec: ai-assistant › Schema-grounded context)
- [ ] 4.2 `Policy::filter` with production rules and redaction of hostnames/usernames; record "Context sent" per message (spec: ai-providers › Data-sharing policy)
- [ ] 4.3 Schema tools `list_tables` / `describe_table` from the completion snapshot; refuse other tools; cap 8 calls per turn
- [ ] 4.4 Test: production + attached rows refused; redaction; tool refusal
- [ ] 4.5 Graph connections: `cypher` dialect and a context builder that reads `SchemaSnapshot.graph` (labels with counts, relationship types, property keys, indexes) (carried over from `add-graph-browser` 5.2; spec: graph-browser › Explorer, palette and AI integration)

## 5. Assistant panel

- [ ] 5.1 Register the AI toolbar toggle (Mod+I) and side panel content: header, Chat/History tabs, production notice, empty state (spec: ai-assistant › Assistant side panel)
- [ ] 5.2 Composer: context chips, @-mention picker, slash commands, Ask/Edit switch, one-line model picker, Enter/Shift+Enter (spec: ai-assistant › Composer)
- [ ] 5.3 Message list with streaming Markdown, SQL code blocks (Copy, Insert at cursor), model/context header, suggestion chips, Stop, Retry (spec: ai-assistant › Streaming answers)
- [ ] 5.4 Chat persistence and History tab (spec: ai-assistant › Chat history)
- [ ] 5.5 Status bar AI items (spec: ai-assistant › AI status in the status bar)
- [ ] 5.6 Test: streaming render, stop, retry keeps composer text

## 6. Edit mode and review

- [ ] 6.1 `edit_console` tool definition, validation (in-range, non-overlapping) and Ask-mode exclusion (spec: ai-assistant › Ask and Edit modes)
- [ ] 6.2 Unified inline diff with @codemirror/merge styled to tokens; per-hunk Keep/Undo (spec: ai-assistant › Direct edits with review)
- [ ] 6.3 Floating review bar (count, +/−, prev/next, Undo all, Keep all) and the chat's Edited card sharing chunk state
- [ ] 6.4 Single-transaction Keep all / Undo all; Run-with-pending prompt; hunks track user edits
- [ ] 6.5 Fix with AI (Mod+Alt+F) / Explain error buttons in Output (spec: ai-assistant › Fix and explain errors)
- [ ] 6.6 Test: apply/keep/undo combinations; run-with-pending prompt; AI can never trigger execution

## 7. Inline completions

- [ ] 7.1 Ghost-text CodeMirror extension with debounce, cancel, accept (Tab, Mod+Right), cycle (Alt+]/[), dismiss, popup precedence (spec: ai-inline-completion › Ghost-text completions)
- [ ] 7.2 `ai_complete` command routing to the configured completion provider with context limits and policy (spec: ai-inline-completion › Completion context and limits)
- [ ] 7.3 Error backoff (pause 60 s after 3 failures) and status bar state
- [ ] 7.4 Test: typing-through keeps suggestion; cancellation; popup precedence

## 8. Shell integration

- [ ] 8.1 Verify the shell's network rule (app-shell › Offline by default): AI traffic goes only to configured endpoints and the consented Copilot download; add a test that no request is made while AI is disabled

## 9. End-to-end

- [ ] 9.1 E2E: add journey J-17 in `e2e/specs/` — against the mock LLM: Edit mode writes a reviewable diff, Keep/Undo per hunk, Keep all, AI never executes SQL, production sends schema only (assert from the mock's request log), ghost-text accept
- [ ] 9.2 Declare `covers(...)` for the scenarios it exercises (e.g. ai-assistant › Direct edits with review; ai-providers › Data-sharing policy) and add the seed/compose service it needs to the matching profile

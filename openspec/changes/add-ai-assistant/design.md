## Context

Canvas: `design/canvas/AIAssistant.dc.html` (panel, composer, inline diff review in the editor, Edited card, Fix with AI) and `design/canvas/AIProviders.dc.html` (interactive: provider list, Copilot sign-in states, key forms, custom endpoint, local, routing and privacy). The shell provides the right side panel slot; the console provides the editor and Output tab; safeguards provide the production policy hook.

## Goals / Non-Goals

**Goals:** bring-your-own-model with five provider kinds; schema-grounded answers; edits that land in the editor as a reviewable diff; strict, visible data-sharing rules; AI can never execute SQL.
**Non-Goals:** an autonomous agent that runs queries; embeddings / RAG over data; AI in the table editor or document browser (later); hosting any model or proxy ourselves.

## Decisions

### Provider layer in Rust
All network calls happen in Rust (`ai/providers/`), never from the WebView, so keys never enter JS and CSP stays `self`-only.
```rust
#[async_trait] trait ChatProvider { async fn models(&self) -> Result<Vec<ModelInfo>>;
  async fn chat(&self, req: ChatRequest, sink: Channel<ChatEvent>, cancel: CancelToken) -> Result<()>; }
#[async_trait] trait CompletionProvider { async fn complete(&self, req: FimRequest, cancel: CancelToken) -> Result<Vec<String>>; }
```
Implementations: `anthropic` (Messages API, SSE streaming, tool use), `openai` (Chat Completions with tools; works for OpenAI, OpenAI-compatible custom endpoints and Ollama/LM Studio), `anthropic_compatible` (same as anthropic with custom base/auth), `copilot` (via the language server, below). Model lists come from each provider's models endpoint; Claude's default model id is `claude-sonnet-5-5`.

### GitHub Copilot through GitHub's language server
GitHub publishes `@github/copilot-language-server` for editor integrations (LSP over stdio). Clew:
1. On first Copilot sign-in, asks consent, downloads the package tarball for the pinned version from the npm registry, verifies the registry's `integrity` (sha512), and unpacks it under `<app_data>/copilot/<version>/`.
2. Launches it (native binary if the package provides one for the platform, otherwise its JS entry with a Node runtime found on PATH; if neither is available, the UI explains how to install Node).
3. Uses its sign-in requests (`signInInitiate` → device code + verification URL, `signInConfirm`/status polling, `signOut`, `checkStatus`) and inline completions (`textDocument/inlineCompletion`) on a virtual document mirroring the console text.
Copilot is offered for inline completions in v1; Copilot chat is behind the "Use Copilot for chat too" option only if the language server exposes a supported chat API in the pinned version.

### Context assembly and policy (`ai/context.rs`, `ai/policy.rs`)
`ContextBuilder` collects candidate items (dialect, server version, mentioned tables, referenced tables found by parsing the statement with `sqlparser`, statement/selection, last error, attached rows). `Policy::filter(items, connection)` removes what the user's settings or the production policy forbid, and redacts hostnames/usernames from error text. The final list is recorded with the message ("Context sent").

### Tools exposed to the model
Only `list_tables(filter?)` and `describe_table(name)`, both answered from the completion snapshot (no live queries). Tool calls are capped at 8 per turn.

### Edit mode protocol
In Edit mode the system prompt gives the model the console text with line numbers and one tool: `edit_console({ edits: [{ start_line, end_line, replacement }] , summary })`. Clew validates that ranges are inside the document and non-overlapping, applies them to a copy, and shows the result with `@codemirror/merge`'s `unifiedMergeView` (original = text before the edit), styled to tokens: deleted chunks `--grid-deleted-row` + strikethrough, inserted chunks `--grid-inserted-row`, changed-word highlights, per-chunk Keep/Undo (`acceptChunk` / `rejectChunk`). The floating review bar and the chat's Edited card read the same chunk state. Keep all/Undo all are single undo-history transactions.

### Inline completions
A CodeMirror extension (`ai/inlineCompletion.ts`) renders ghost text as a widget decoration; it requests via `ai_complete` (debounced 300 ms, cancellable). The schema popup has precedence via `completionStatus(state)`.

### Storage
Chats in `clew.db` (`ai_chats`, `ai_messages` with context JSON). API keys and custom tokens in the keychain (`Clew` / `ai:<provider-id>`). Copilot's own auth is managed by the language server in its config directory; Sign out calls its sign-out request.

### Shortcuts
Mod+I toggle panel; Mod+Shift+I "Ask about selection"; Fix with AI: Mod+Alt+F (not Mod+Shift+F, which is Format SQL); review bar Mod+Enter / Mod+Backspace only while a review is active (they override Run while review is focused — the Run-with-pending prompt covers the rest).

## Risks / Trade-offs

- [Copilot language-server terms and packaging] → Download on demand rather than bundling; pin a version; if GitHub's terms don't allow this use, ship without Copilot (other providers unaffected). See Open Questions.
- [Prompt injection via schema comments or data] → Data rows aren't sent by default; the model's only actions are schema lookups and proposing edits that a human reviews; it can't execute anything.
- [Cost surprises with API keys] → Show the model and approximate tokens per message; no background chat calls.
- [Hallucinated columns] → Edits are reviewed in a diff; the console's normal completion and errors still apply.

## Open Questions

- Confirm GitHub's terms permit an open-source third-party app to download and drive `@github/copilot-language-server` with users' own Copilot subscriptions, and whether a Node runtime must be present. Decide before implementing tasks group 3.
- Should "Sign in with ChatGPT" (account-based Codex access) be offered for OpenAI in addition to API keys? Only if OpenAI documents it for third-party apps.

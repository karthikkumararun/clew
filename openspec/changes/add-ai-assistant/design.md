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

## Open Questions (resolved while building)

- **Copilot licensing and packaging: settled.** `@github/copilot-language-server` is MIT-licensed and GitHub documents it as a way for "any editor or IDE to integrate with GitHub Copilot via the language server protocol". It signs in with GitHub's device flow, serves `textDocument/inlineCompletion`, and ships as a single native binary per platform in the npm packages `@github/copilot-language-server-<os>-<arch>` (about 96 MB compressed), so no Node runtime is needed. Using it with a person's own Copilot subscription is what the product is for; the subscription's terms apply to the user, and the component is downloaded only after they agree. If GitHub's terms ever change, removing the Copilot provider leaves the others untouched.
- **"Sign in with ChatGPT"** is not offered: OpenAI documents API keys for third-party apps and nothing else.
- **Copilot chat** is not offered in v1: the language server's documented surface is sign-in and inline completions, so "Use Copilot for chat too" is shown disabled with the reason.

## Implementation notes

Decisions taken while building, where the first draft was silent or needed to change:

- **Keychain account.** A provider's key is stored under service `Clew`, account `ai:<provider id>:ai-key` (the `SecretKind::AiKey` variant), not `ai:<provider id>` as the sketch said, so it goes through the same `SecretStore` as connection secrets (and the same test-mode file store). Removing a provider deletes its key.
- **Settings file.** `ai.json` in the data directory holds everything that is not secret: providers (kind, base URL, model, auth style and header name, extra headers), routing, privacy and the Copilot toggles. A corrupt file is moved aside and AI starts off.
- **One door to the network.** `AiService::open(route, explicit)` checks the master switch, resolves the provider and builds it; chat and ghost-text requests only reach a provider through it, so "nothing is sent until AI is on and a provider is set up" has a single place to be tested. Test connection and model listing are the user's explicit actions in Settings and are allowed before the switch is on. Copilot's size lookup (a metadata request to the npm registry) happens when the user presses "Sign in with GitHub" for the first time, before the download itself, which waits for consent.
- **Referenced tables** are found by matching identifiers in the statement against the snapshot's table names, not by parsing with `sqlparser`: it works for statements that do not parse (the ones being fixed) and for every dialect. Keys and indexes are not in the completion snapshot, so the schema items hold columns and types; graph connections add labels, relationship types, property keys, indexes and constraints.
- **Production policy.** "Schema only, never row data" means no rows; the schema and SQL toggles still apply. "Same as other connections" follows all toggles. "Disable AI entirely" refuses chat, completions and Fix with AI, and the panel says "AI is off for Production connections".
- **Edit protocol.** Lines are 1-based; an insertion before line N has `end_line = N - 1`; an empty replacement deletes the lines. Rust validates (in range, no overlap) and the same edits are applied by `src/features/ai/lineEdits.ts` (parity tests on both sides). If the console changed while the request ran, the edit is not applied and the reply says so.
- **Review.** The edit is one transaction (so Mod+Z after Keep all undoes it whole). `unifiedMergeView` shows the diff against the text before the edit; Keep and Undo on a hunk use `acceptChunk` / `rejectChunk`. Text the user types outside the hunks is folded into the baseline (a transaction extender), so it is not shown as a hunk and the hunks follow it. Mod+Enter / Mod+Backspace keep or undo all while a review is active; the toolbar Run button and menu raise the Run-with-pending prompt.
- **Completions for non-Copilot providers** ask the chat model for only the text to insert at the cursor (a fill-in-the-middle prompt in a single message), cancelled when the user types again; there is no provider-specific FIM endpoint. Errors count towards the 3-in-a-row pause; a cancelled or "AI off" answer does not.
- **Chats** are stored as opaque JSON bodies next to ids that order and list them (`ai_chats`, `ai_messages`). The rows of an attachment are never stored; a reply cut off when the app closed reads as Stopped when reopened.
- **Not in this change.** Copilot chat; provider-native FIM endpoints; matching the number of tokens sent per message in the UI; AI in the table editor and the document browser.

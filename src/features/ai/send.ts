import { aiCancel, aiChat, aiChatSave, aiPolicy } from "./api";
import type { AiEvent, ChatInput, ProviderConfig } from "./api";
import {
  consoleContext,
  defaultDatabase,
  explainPlanText,
  linesLabel,
  serverVersionOf,
} from "./activeContext";
import type { ConsoleContext } from "./activeContext";
import { useChat, newId } from "./chatStore";
import type { AiMode, Attachment, ChatMessage } from "./chatStore";
import { beginReview } from "./review";
import { chatProvider, configuredProviders, useAiSettings } from "./settingsStore";
import { shortModel } from "./providers";
import { openConsole } from "../console/commands";
import { getView } from "../console/editor/views";
import { useLayout } from "../../stores/layoutStore";
import { useWorkspace } from "../../stores/workspaceStore";

export type Feature = "chat" | "fix" | "nl_sql";

export interface SlashCommand {
  name: string;
  hint: string;
  feature: Feature;
  /** The request the model receives. */
  prompt: (rest: string) => string;
}

export const SLASH: SlashCommand[] = [
  {
    name: "explain",
    hint: "Explain the statement step by step",
    feature: "chat",
    prompt: (rest) => `Explain this query step by step.${rest ? ` ${rest}` : ""}`,
  },
  {
    name: "fix",
    hint: "Fix the error and say why it happened",
    feature: "fix",
    prompt: (rest) =>
      `Fix the error in this query and explain why it happened.${rest ? ` ${rest}` : ""}`,
  },
  {
    name: "optimize",
    hint: "Make the query faster",
    feature: "chat",
    prompt: (rest) =>
      `Optimize this query for speed, and suggest indexes if they would help.${rest ? ` ${rest}` : ""}`,
  },
  {
    name: "generate",
    hint: "Write a query from a description",
    feature: "nl_sql",
    prompt: (rest) => `Write a query for this: ${rest || "(describe what you need)"}`,
  },
];

/** `/optimize make it use an index` → the command and the rest of the line. */
export function parseSlash(text: string): { command: SlashCommand; rest: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  const command = m && SLASH.find((c) => c.name === m[1].toLowerCase());
  return command ? { command, rest: (m[2] ?? "").trim() } : null;
}

/** `Claude Sonnet 5.5`, or the model id of other providers. */
export function modelLabel(cfg: ProviderConfig, model: string): string {
  const short = shortModel(model || cfg.model);
  return cfg.kind === "anthropic" && short !== model ? `Claude ${short}` : short || cfg.name;
}

/** The provider and model a request uses: the picker, else the routed chat provider. */
export function currentModel(): { cfg: ProviderConfig; model: string } | null {
  const pick = useChat.getState().pick;
  if (pick) {
    const cfg = configuredProviders().find((p) => p.id === pick.providerId);
    if (cfg) return { cfg, model: pick.model || cfg.model };
  }
  const cfg = chatProvider();
  return cfg ? { cfg, model: cfg.model } : null;
}

async function persist(connectionId: string, message: ChatMessage) {
  const chat = useChat.getState().chats[connectionId];
  if (!chat) return;
  const seq = chat.messages.findIndex((m) => m.id === message.id);
  try {
    await aiChatSave(
      {
        id: chat.id,
        connectionId,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: Date.now(),
      },
      {
        id: message.id,
        seq: Math.max(seq, 0),
        role: message.role,
        // Text and chips only: the rows of an attachment are never stored.
        body: JSON.stringify(message),
      },
    );
  } catch {
    /* history is a convenience; the conversation continues */
  }
}

/** Wait for a console tab's editor to mount. */
async function editorOf(tabId: string, ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = getView(tabId);
    if (v) return v;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface SendOptions {
  feature?: Feature;
  /** What the model is asked, when it differs from what the user typed (slash commands). */
  prompt?: string;
  mode?: AiMode;
  attachments?: Attachment[];
  mentions?: string[];
  /** Lines of the console the question is about, when not the cursor's statement. */
  lines?: [number, number];
  /** Resend an earlier user message instead of adding a new one. */
  retryOf?: ChatMessage;
}

/**
 * Send a message and stream the answer into the chat. Resolves when the answer is complete,
 * stopped or failed. AI-written SQL is never run: edits go to the editor as a pending review.
 */
export async function sendMessage(
  connectionId: string,
  typed: string,
  opts: SendOptions = {},
): Promise<void> {
  const store = useChat.getState();
  if (store.running) return;
  const target = currentModel();
  if (!target) return;
  const mode = opts.mode ?? store.mode;
  const slash = opts.retryOf ? null : parseSlash(typed);
  const feature = opts.retryOf?.sent?.feature ?? opts.feature ?? slash?.command.feature ?? "chat";
  const prompt =
    opts.retryOf?.sent?.prompt ?? opts.prompt ?? slash?.command.prompt(slash.rest) ?? typed;

  // What the policy allows for this connection, before anything is gathered.
  let access;
  try {
    access = await aiPolicy(connectionId);
  } catch {
    access = null;
  }

  let ctx: ConsoleContext | null = consoleContext(connectionId);
  if (mode === "edit" && !ctx && access?.allowed !== false) {
    // Edit mode without a console: write into a new one.
    const tabId = await openConsole({ connectionId });
    if (tabId) {
      await editorOf(tabId);
      ctx = consoleContext(connectionId);
    }
  }

  const retry = opts.retryOf;
  const attachments = opts.attachments ?? [];
  const selectionChip = attachments.find((a) => a.kind === "selection");
  const statement =
    retry?.sent?.statement ??
    attachments.find((a) => a.statement)?.statement ??
    selectionChip?.text ??
    ctx?.statement ??
    "";
  const error = retry?.sent?.error ?? attachments.find((a) => a.kind === "error")?.text;
  const rows = attachments.find((a) => a.kind === "rows")?.rows;
  const mentions = retry?.sent?.mentions ?? opts.mentions ?? [];
  const plan = slash?.command.name === "optimize" ? explainPlanText(connectionId) : null;

  const now = Date.now();
  const user: ChatMessage = retry ?? {
    id: newId("msg"),
    role: "user",
    text: typed.trim(),
    at: now,
    mode,
    chips: [
      ...(statement || selectionChip
        ? [{ label: linesLabel(opts.lines ?? ctx?.lines ?? null), kind: "console" as const }]
        : []),
      ...mentions.map((m) => ({ label: `@${m}`, kind: "mention" as const })),
      ...attachments
        .filter((a) => a.kind !== "selection")
        .map((a) => ({ label: a.label, kind: a.kind as "error" | "rows" })),
    ],
    sent: { prompt, feature, statement: statement || undefined, error, mentions },
  };
  const assistant: ChatMessage = {
    id: newId("msg"),
    role: "assistant",
    text: "",
    at: now,
    mode,
    model: modelLabel(target.cfg, target.model),
    status: "streaming",
  };
  const history = useChat
    .getState()
    .chatOf(connectionId)
    .messages.filter((m) => m.status !== "error" && m.status !== "streaming" && m.id !== user.id)
    .filter((m) => m.text.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, text: m.sent?.prompt ?? m.text }));

  if (!retry) useChat.getState().addMessage(connectionId, user);
  useChat.getState().addMessage(connectionId, assistant);
  if (!retry) void persist(connectionId, user);
  // A retry leaves what the user is typing alone.
  if (!retry) useChat.getState().clearComposer(connectionId);

  const requestId = newId("req");
  useChat.getState().setRunning({ requestId, connectionId, messageId: assistant.id });
  const patch = (change: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) =>
    useChat.getState().patchMessage(connectionId, assistant.id, change);

  const textAtRequest = ctx?.text ?? "";
  const tabId = ctx?.tabId;
  const input: ChatInput = {
    requestId,
    feature,
    providerId: target.cfg.id,
    model: target.model || null,
    mode,
    connectionId,
    database: ctx?.database ?? defaultDatabase(connectionId),
    text: plan ? `${prompt}\n\nEXPLAIN plan:\n${plan}` : prompt,
    mentions,
    statement: statement || null,
    error: error ?? null,
    rows: rows ?? null,
    consoleText: mode === "edit" && ctx ? textAtRequest : null,
    serverVersion: serverVersionOf(connectionId) ?? null,
    history,
  };

  const onEvent = (e: AiEvent) => {
    switch (e.kind) {
      case "context":
        patch({ context: e.items });
        break;
      case "text":
        patch((m) => ({ text: m.text + e.text }));
        break;
      case "read":
        patch({ read: e.tables });
        break;
      case "suggestions":
        patch({ suggestions: e.items });
        break;
      case "edit":
        applyEdit(e);
        break;
      case "done":
        patch((m) => (m.status === "streaming" ? { status: "done" } : {}));
        break;
    }
  };

  const applyEdit = (e: Extract<AiEvent, { kind: "edit" }>) => {
    const view = tabId ? getView(tabId) : undefined;
    const append = (note: string) =>
      patch((m) => ({ text: `${m.text}${m.text ? "\n\n" : ""}${note}` }));
    if (!tabId || !view) {
      append("I couldn't write to the console because it isn't open.");
      return;
    }
    if (view.state.doc.toString() !== textAtRequest) {
      append("The console changed while I was working, so I didn't apply my edit. Ask again.");
      return;
    }
    const r = beginReview(tabId, e.edits, e.summary);
    if (!r.ok) {
      append(`I couldn't apply the edit: ${r.reason}.`);
      return;
    }
    const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
    patch({
      edit: {
        reviewId: r.id,
        tabId,
        tabName: ctx?.tabName ?? (tab ? "console" : "console"),
        summary: e.summary,
      },
    });
  };

  try {
    await aiChat(input, onEvent);
    patch((m) => (m.status === "streaming" ? { status: "done" } : {}));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "cancelled") {
      patch((m) => ({ status: m.status === "streaming" ? "stopped" : m.status }));
    } else {
      patch({
        status: "error",
        error: { code: err.code ?? "ai_error", message: err.message ?? "The request failed" },
      });
    }
  } finally {
    useChat.getState().setRunning(null);
    const finalMsg = useChat
      .getState()
      .chats[connectionId]?.messages.find((m) => m.id === assistant.id);
    if (finalMsg) void persist(connectionId, finalMsg);
  }
}

/** Stop the reply that is streaming; what has arrived stays, marked Stopped. */
export function stopRunning() {
  const run = useChat.getState().running;
  if (!run) return;
  useChat
    .getState()
    .patchMessage(run.connectionId, run.messageId, (m) =>
      m.status === "streaming" ? { status: "stopped" } : {},
    );
  void aiCancel(run.requestId).catch(() => {});
}

/** Send the user message before a failed (or stopped) answer again; the composer is untouched. */
export async function retryMessage(connectionId: string, assistantId: string) {
  const chat = useChat.getState().chats[connectionId];
  if (!chat) return;
  const i = chat.messages.findIndex((m) => m.id === assistantId);
  const user = [...chat.messages.slice(0, i)].reverse().find((m) => m.role === "user");
  if (!user) return;
  useChat.getState().removeMessage(connectionId, assistantId);
  await sendMessage(connectionId, user.text, { retryOf: user, mode: user.mode });
}

/** Open the panel. */
export function openAssistant() {
  useLayout.getState().openSidePanel();
}

/** Whether a chat model is set up and the master switch is on. */
export function assistantReady(): boolean {
  return useAiSettings.getState().settings.enabled && currentModel() !== null;
}

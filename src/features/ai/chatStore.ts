import { create } from "zustand";
import type { ContextItem, RowsAttachment } from "./api";

export type AiMode = "ask" | "edit";

/** A piece of context shown as a chip in the composer and on the sent message. */
export interface Attachment {
  kind: "selection" | "error" | "rows";
  label: string;
  /** The text itself (selection or error). */
  text?: string;
  rows?: RowsAttachment;
  /** The statement the error belongs to, for Fix with AI. */
  statement?: string;
}

export interface EditRef {
  reviewId: number;
  tabId: string;
  tabName: string;
  summary: string;
}

export type MessageStatus = "streaming" | "done" | "stopped" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  mode: AiMode;
  /** User messages: the chips that were attached. */
  chips?: { label: string; kind: "console" | "error" | "rows" | "mention" }[];
  /** Assistant messages. */
  model?: string;
  read?: string[];
  context?: ContextItem[];
  status?: MessageStatus;
  error?: { code: string; message: string };
  suggestions?: string[];
  edit?: EditRef;
  /** User messages: what was sent besides the typed text, so Retry can send it again. */
  sent?: {
    prompt: string;
    feature: "chat" | "fix" | "nl_sql";
    statement?: string;
    error?: string;
    mentions: string[];
  };
}

export interface Chat {
  id: string;
  connectionId: string;
  title: string;
  createdAt: number;
  messages: ChatMessage[];
}

export interface Composer {
  text: string;
  mentions: string[];
  attachments: Attachment[];
}

export const EMPTY_COMPOSER: Composer = { text: "", mentions: [], attachments: [] };

interface ChatStore {
  /** The open chat of each connection. */
  chats: Record<string, Chat>;
  composers: Record<string, Composer>;
  mode: AiMode;
  /** The model picked in the composer; `null` follows the routing. */
  pick: { providerId: string; model: string } | null;
  view: "chat" | "history";
  /** The request in flight, if any. */
  running: { requestId: string; connectionId: string; messageId: string } | null;
  setMode: (mode: AiMode) => void;
  setPick: (pick: { providerId: string; model: string } | null) => void;
  setView: (view: "chat" | "history") => void;
  setComposer: (connectionId: string, change: Partial<Composer>) => void;
  clearComposer: (connectionId: string) => void;
  /** The open chat of a connection, created empty on first use. */
  chatOf: (connectionId: string) => Chat;
  startChat: (connectionId: string) => Chat;
  openChat: (chat: Chat) => void;
  addMessage: (connectionId: string, message: ChatMessage) => void;
  patchMessage: (
    connectionId: string,
    messageId: string,
    change: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>),
  ) => void;
  removeMessage: (connectionId: string, messageId: string) => void;
  setRunning: (running: ChatStore["running"]) => void;
}

let counter = 0;
export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const blank = (connectionId: string): Chat => ({
  id: newId("chat"),
  connectionId,
  title: "",
  createdAt: Date.now(),
  messages: [],
});

export const useChat = create<ChatStore>((set, get) => ({
  chats: {},
  composers: {},
  mode: "ask",
  pick: null,
  view: "chat",
  running: null,
  setMode: (mode) => set({ mode }),
  setPick: (pick) => set({ pick }),
  setView: (view) => set({ view }),
  setComposer: (connectionId, change) =>
    set((s) => ({
      composers: {
        ...s.composers,
        [connectionId]: { ...(s.composers[connectionId] ?? EMPTY_COMPOSER), ...change },
      },
    })),
  clearComposer: (connectionId) =>
    set((s) => ({ composers: { ...s.composers, [connectionId]: EMPTY_COMPOSER } })),
  chatOf: (connectionId) => {
    const existing = get().chats[connectionId];
    if (existing) return existing;
    return get().startChat(connectionId);
  },
  startChat: (connectionId) => {
    const chat = blank(connectionId);
    set((s) => ({ chats: { ...s.chats, [connectionId]: chat } }));
    return chat;
  },
  openChat: (chat) =>
    set((s) => ({ chats: { ...s.chats, [chat.connectionId]: chat }, view: "chat" })),
  addMessage: (connectionId, message) =>
    set((s) => {
      const chat = s.chats[connectionId] ?? blank(connectionId);
      const title =
        chat.title || (message.role === "user" ? message.text.trim().slice(0, 80) : chat.title);
      return {
        chats: {
          ...s.chats,
          [connectionId]: { ...chat, title, messages: [...chat.messages, message] },
        },
      };
    }),
  patchMessage: (connectionId, messageId, change) =>
    set((s) => {
      const chat = s.chats[connectionId];
      if (!chat) return s;
      return {
        chats: {
          ...s.chats,
          [connectionId]: {
            ...chat,
            messages: chat.messages.map((m) =>
              m.id === messageId
                ? { ...m, ...(typeof change === "function" ? change(m) : change) }
                : m,
            ),
          },
        },
      };
    }),
  removeMessage: (connectionId, messageId) =>
    set((s) => {
      const chat = s.chats[connectionId];
      if (!chat) return s;
      return {
        chats: {
          ...s.chats,
          [connectionId]: { ...chat, messages: chat.messages.filter((m) => m.id !== messageId) },
        },
      };
    }),
  setRunning: (running) => set({ running }),
}));

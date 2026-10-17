import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../../lib/ipc";
import type { Access } from "../../lib/ipc/generated/Access";
import type { AiEvent } from "../../lib/ipc/generated/AiEvent";
import type { AiSettings } from "../../lib/ipc/generated/AiSettings";
import type { ChatInput } from "../../lib/ipc/generated/ChatInput";
import type { ChatSummary } from "../../lib/ipc/generated/ChatSummary";
import type { ModelInfo } from "../../lib/ipc/generated/ModelInfo";
import type { ProviderConfig } from "../../lib/ipc/generated/ProviderConfig";
import type { StoredMessage } from "../../lib/ipc/generated/StoredMessage";
import type { TestResult } from "../../lib/ipc/generated/TestResult";

export type {
  Access,
  AiEvent,
  AiSettings,
  ChatInput,
  ChatSummary,
  ModelInfo,
  ProviderConfig,
  StoredMessage,
  TestResult,
};
export type { ContextItem } from "../../lib/ipc/generated/ContextItem";
export type { LineEdit } from "../../lib/ipc/generated/LineEdit";
export type { RowsAttachment } from "../../lib/ipc/generated/RowsAttachment";

export interface AiSettingsPayload {
  settings: AiSettings;
  /** Which providers have a key or token in the keychain. */
  secrets: Record<string, boolean>;
  notice: string | null;
}

export const aiSettingsGet = () => invoke<AiSettingsPayload>("ai_settings_get");
export const aiSettingsSet = (settings: AiSettings) =>
  invoke<AiSettingsPayload>("ai_settings_set", { settings });
export const aiSecretSet = (providerId: string, secret: string) =>
  invoke<void>("ai_secret_set", { providerId, secret });
export const aiSecretClear = (providerId: string) =>
  invoke<void>("ai_secret_clear", { providerId });
export const aiModels = (config: ProviderConfig, secret?: string) =>
  invoke<ModelInfo[]>("ai_models", { config, secret: secret || null });
export const aiTestProvider = (config: ProviderConfig, secret?: string) =>
  invoke<TestResult>("ai_test_provider", { config, secret: secret || null });
export const aiPolicy = (connectionId: string) => invoke<Access>("ai_policy", { connectionId });
export const aiCancel = (requestId: string) => invoke<boolean>("ai_cancel", { requestId });
export const aiComplete = (input: {
  requestId: string;
  connectionId: string;
  database: string;
  prefix: string;
  suffix: string;
}) => invoke<string[]>("ai_complete", { input });

export const aiChatsList = (connectionId?: string) =>
  invoke<ChatSummary[]>("ai_chats_list", { connectionId: connectionId ?? null });
export const aiChatLoad = (chatId: string) => invoke<StoredMessage[]>("ai_chat_load", { chatId });
export const aiChatSave = (chat: ChatSummary, message: StoredMessage) =>
  invoke<void>("ai_chat_save", { chat, message });
export const aiChatsDelete = (opts: { chatId?: string; connectionId?: string }) =>
  invoke<number>("ai_chats_delete", {
    chatId: opts.chatId ?? null,
    connectionId: opts.connectionId ?? null,
  });

/** How long to wait for the closing event after the command's reply (see `ai_chat`). */
const CLOSING_WAIT_MS = 1500;

/**
 * Run one assistant request. Events arrive on a channel of their own and can trail the command's
 * reply, so the promise waits for the closing `done` event when the command succeeded.
 */
export async function aiChat(input: ChatInput, onEvent: (event: AiEvent) => void): Promise<void> {
  const channel = new Channel<AiEvent>();
  let done = false;
  const waiters: (() => void)[] = [];
  channel.onmessage = (e) => {
    onEvent(e);
    if (e.kind === "done") {
      done = true;
      waiters.splice(0).forEach((w) => w());
    }
  };
  await invoke<void>("ai_chat", { input, onEvent: channel });
  if (!done) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, CLOSING_WAIT_MS);
      waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

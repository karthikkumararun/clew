import { useEffect, useState } from "react";
import { Close } from "../../components/icons";
import { useNotices } from "../../stores/noticesStore";
import { aiChatLoad, aiChatsDelete, aiChatsList } from "./api";
import type { ChatSummary } from "./api";
import { newId, useChat } from "./chatStore";
import type { ChatMessage } from "./chatStore";
import styles from "./Panel.module.css";

const day = (ms: number) =>
  new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

/** A stored message back as the panel keeps it; a reply that was cut off reads as stopped. */
export function parseStored(body: string): ChatMessage | null {
  try {
    const m = JSON.parse(body) as ChatMessage;
    if (!m || typeof m.id !== "string" || (m.role !== "user" && m.role !== "assistant"))
      return null;
    return m.status === "streaming" ? { ...m, status: "stopped" } : m;
  } catch {
    return null;
  }
}

/** Past chats of the connection (spec: ai-assistant › Chat history). */
export function HistoryView({ connectionId }: { connectionId: string }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const openChat = useChat((s) => s.openChat);
  const current = useChat((s) => s.chats[connectionId]);

  const reload = () =>
    void aiChatsList(connectionId)
      .then(setChats)
      .catch(() => setChats([]));
  useEffect(reload, [connectionId]);

  const open = async (c: ChatSummary) => {
    try {
      const stored = await aiChatLoad(c.id);
      openChat({
        id: c.id,
        connectionId,
        title: c.title,
        createdAt: c.createdAt,
        messages: stored.map((s) => parseStored(s.body)).filter((m): m is ChatMessage => !!m),
      });
    } catch {
      useNotices.getState().push("Couldn't open that chat");
    }
  };

  const remove = async (c: ChatSummary) => {
    await aiChatsDelete({ chatId: c.id }).catch(() => {});
    // Deleting the open chat leaves an empty one in its place.
    if (current?.id === c.id)
      useChat.setState((s) => ({
        chats: {
          ...s.chats,
          [connectionId]: {
            id: newId("chat"),
            connectionId,
            title: "",
            createdAt: Date.now(),
            messages: [],
          },
        },
      }));
    reload();
  };

  const removeAll = async () => {
    await aiChatsDelete({ connectionId }).catch(() => {});
    useChat.setState((s) => {
      const rest = { ...s.chats };
      delete rest[connectionId];
      return { chats: rest };
    });
    reload();
  };

  if (chats === null) return <p className={styles.empty}>Loading…</p>;
  if (chats.length === 0)
    return <p className={styles.empty}>No past chats for this connection yet.</p>;
  return (
    <div className={styles.history}>
      <ul aria-label="Past chats" className={styles.historyList}>
        {chats.map((c) => (
          <li key={c.id} className={styles.historyItem}>
            <button type="button" className={styles.historyOpen} onClick={() => void open(c)}>
              <span className={styles.historyTitle}>{c.title || "Untitled chat"}</span>
              <span className={styles.historyDate}>{day(c.updatedAt)}</span>
            </button>
            <button
              type="button"
              className={styles.historyDelete}
              aria-label={`Delete chat: ${c.title || "Untitled chat"}`}
              onClick={() => void remove(c)}
            >
              <Close size={11} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className={styles.small} onClick={() => void removeAll()}>
        Delete all chats
      </button>
      <p className={styles.note}>Chats are stored on this computer only.</p>
    </div>
  );
}

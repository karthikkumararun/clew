import { useEffect, useRef, useState } from "react";
import { Star } from "../../components/icons";
import { getView } from "../console/editor/views";
import { activeConsoleTab, openConsole } from "../console/commands";
import { useNotices } from "../../stores/noticesStore";
import { EditCard } from "./EditCard";
import { Markdown } from "./markdown";
import { useChat } from "./chatStore";
import type { ChatMessage } from "./chatStore";
import { retryMessage, sendMessage } from "./send";
import styles from "./Panel.module.css";

/** Put code into the active console at the cursor (a new console when there is none). */
export async function insertAtCursor(connectionId: string, code: string) {
  const tab = activeConsoleTab();
  const view = tab && tab.state.connectionId === connectionId ? getView(tab.id) : undefined;
  if (view) {
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: code },
      selection: { anchor: sel.from + code.length },
      userEvent: "input.paste",
    });
    view.focus();
    return;
  }
  await openConsole({ connectionId, sql: code });
}

const copy = (text: string) =>
  void navigator.clipboard.writeText(text).catch(() => useNotices.getState().push("Couldn't copy"));

function ContextSent({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const items = message.context ?? [];
  if (items.length === 0) return null;
  return (
    <div className={styles.contextSent}>
      <button
        type="button"
        className={styles.linkButton}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Context sent ({items.length})
      </button>
      {open ? (
        <ul className={styles.contextList} aria-label="Context sent">
          {items.map((it, i) => (
            <li key={i}>
              <span className={styles.contextLabel}>{it.label}</span>
              <pre className={styles.contextBody}>{it.content}</pre>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Assistant({ message, connectionId }: { message: ChatMessage; connectionId: string }) {
  const streaming = message.status === "streaming";
  const read = message.read ?? [];
  return (
    <div className={styles.answer} data-testid="assistant-message" data-status={message.status}>
      <div className={styles.answerHead}>
        <Star size={13} className={styles.editIcon} />
        <span>
          {message.model}
          {read.length > 0 ? (
            <>
              {" · read schema of "}
              {read.map((t, i) => (
                <span key={t}>
                  {i > 0 ? ", " : ""}
                  <span className={styles.mono}>{t}</span>
                </span>
              ))}
            </>
          ) : null}
        </span>
      </div>
      {message.text ? (
        <Markdown
          text={message.text}
          actions={{
            onCopy: copy,
            onInsert: (code) => void insertAtCursor(connectionId, code),
          }}
        />
      ) : streaming ? (
        <p className={styles.thinking} role="status">
          Thinking…
        </p>
      ) : null}
      {message.edit ? (
        <>
          <EditCard edit={message.edit} />
          <p className={styles.note}>
            Edits land in the editor straight away as a reviewable diff. Nothing runs until you
            press Run.
          </p>
        </>
      ) : null}
      {message.status === "stopped" ? <p className={styles.stopped}>Stopped</p> : null}
      {message.status === "error" && message.error ? (
        <div className={styles.errorBox} role="alert">
          <span>{message.error.message}</span>
          {message.error.code !== "ai_disabled_production" ? (
            <button
              type="button"
              className={styles.small}
              onClick={() => void retryMessage(connectionId, message.id)}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {message.suggestions?.length && message.status === "done" ? (
        <div className={styles.suggestions}>
          {message.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className={styles.chipButton}
              onClick={() => void sendMessage(connectionId, s)}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
      {message.status !== "streaming" ? <ContextSent message={message} /> : null}
    </div>
  );
}

function User({ message }: { message: ChatMessage }) {
  return (
    <div className={styles.userMsg}>
      {message.chips?.length ? (
        <div className={styles.chips} style={{ justifyContent: "flex-end" }}>
          {message.chips.map((c, i) => (
            <span
              key={i}
              className={`${styles.chip} ${c.kind === "error" ? styles.chipError : ""} ${c.kind !== "error" ? styles.mono : ""}`}
            >
              {c.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className={styles.userBubble}>{message.text}</div>
    </div>
  );
}

/** The conversation, following the newest message while it streams. */
export function MessageList({ connectionId }: { connectionId: string }) {
  const messages = useChat((s) => s.chats[connectionId]?.messages ?? []);
  const end = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, last?.text]);
  return (
    <div className={styles.messages} role="log" aria-label="Conversation" aria-live="polite">
      {messages.map((m) =>
        m.role === "user" ? (
          <User key={m.id} message={m} />
        ) : (
          <Assistant key={m.id} message={m} connectionId={connectionId} />
        ),
      )}
      <div ref={end} />
    </div>
  );
}

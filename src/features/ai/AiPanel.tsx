import { useEffect, useState } from "react";
import { useConnections } from "../../connections/connectionsStore";
import { Warning } from "../../components/icons";
import { useSettings } from "../../stores/settingsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { useExplorer } from "../explorer/explorerStore";
import { aiPolicy } from "./api";
import type { Access } from "./api";
import { assistantConnection } from "./activeContext";
import { useChat } from "./chatStore";
import { Composer } from "./Composer";
import { HistoryView } from "./HistoryView";
import { MessageList } from "./MessageList";
import { currentModel } from "./send";
import { useAiSettings } from "./settingsStore";
import styles from "./Panel.module.css";

/** The connection the assistant is about; re-evaluated when the active tab or selection moves. */
function useAssistantConnection() {
  useWorkspace((s) => s.activeTabId);
  useExplorer((s) => s.selectedId);
  const connections = useConnections((s) => s.file.connections);
  const id = assistantConnection();
  return connections.find((c) => c.id === id) ?? null;
}

function NoProvider() {
  return (
    <div className={styles.emptyState}>
      <p className={styles.emptyTitle}>Connect a model to start</p>
      <p className={styles.empty}>
        Sign in to GitHub Copilot, or add Claude, OpenAI or any compatible endpoint. Keys stay in
        your system keychain.
      </p>
      <button
        type="button"
        className={styles.primarySmall}
        onClick={() => useSettings.getState().openDialog("AI assistant")}
      >
        Open Settings › AI assistant
      </button>
    </div>
  );
}

/** The side panel content (design/canvas/AIAssistant.dc.html). */
export function AiPanel() {
  const connection = useAssistantConnection();
  const settings = useAiSettings((s) => s.settings);
  const loaded = useAiSettings((s) => s.loaded);
  useAiSettings((s) => s.secrets);
  const view = useChat((s) => s.view);
  const pick = useChat((s) => s.pick);
  void pick;
  const [access, setAccess] = useState<Access | null>(null);
  const connectionId = connection?.id;

  useEffect(() => {
    if (!connectionId) {
      setAccess(null);
      return;
    }
    let live = true;
    void aiPolicy(connectionId)
      .then((a) => live && setAccess(a))
      .catch(() => live && setAccess(null));
    return () => {
      live = false;
    };
  }, [connectionId, settings.privacy]);

  if (!loaded) return null;
  if (!settings.enabled || !currentModel()) return <NoProvider />;
  if (!connection) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyTitle}>No connection</p>
        <p className={styles.empty}>Open a connection or a console to ask about its database.</p>
      </div>
    );
  }
  if (view === "history") return <HistoryView connectionId={connection.id} />;

  const off = access && !access.allowed;
  return (
    <div className={styles.panel}>
      {access?.production ? (
        <div className={styles.production} role="note">
          <Warning size={12} />
          {off
            ? "AI is off for Production connections"
            : "Production: AI never runs SQL. Schema only, no row data."}
        </div>
      ) : null}
      <ChatBody connectionId={connection.id} />
      {off ? null : <Composer connection={connection} />}
    </div>
  );
}

function ChatBody({ connectionId }: { connectionId: string }) {
  const empty = useChat((s) => (s.chats[connectionId]?.messages.length ?? 0) === 0);
  const name = useConnections((s) => s.file.connections.find((c) => c.id === connectionId)?.name);
  if (empty) {
    return (
      <div className={styles.messages}>
        <p className={styles.empty}>
          Ask about <span className={styles.mono}>{name}</span>. The assistant reads the schema, can
          propose edits for you to review, and never runs SQL.
        </p>
      </div>
    );
  }
  return <MessageList connectionId={connectionId} />;
}

import { Star } from "../../components/icons";
import { IconButton } from "../../components/Button";
import { Plus } from "../../components/icons";
import { registerCommand } from "../../shell/registry/commands";
import { registerSidePanel } from "../../shell/registry/slots";
import { registerStatusItem } from "../../shell/registry/statusItems";
import { useLayout } from "../../stores/layoutStore";
import { useSettings } from "../../stores/settingsStore";
import { AiPanel } from "./AiPanel";
import { assistantConnection, consoleContext } from "./activeContext";
import { useChat } from "./chatStore";
import { completionsPaused, useCompletionState } from "./completionState";
import { focusComposer } from "./Composer";
import { useCopilot } from "./copilotStore";
import { fixWithAi } from "./fix";
import { modelLabel, currentModel } from "./send";
import { useAiSettings } from "./settingsStore";
import styles from "./Panel.module.css";

export const AI_PANEL_ID = "ai";

function Tabs() {
  const view = useChat((s) => s.view);
  const setView = useChat((s) => s.setView);
  return (
    <div role="tablist" aria-label="Assistant views" className={styles.tabs}>
      {(["chat", "history"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          onClick={() => setView(v)}
        >
          {v === "chat" ? "Chat" : "History"}
        </button>
      ))}
    </div>
  );
}

function NewChat() {
  return (
    <IconButton
      aria-label="New chat"
      onClick={() => {
        const id = assistantConnection();
        if (id) useChat.getState().startChat(id);
        useChat.getState().setView("chat");
        queueMicrotask(focusComposer);
      }}
    >
      <Plus size={14} />
    </IconButton>
  );
}

/** What the right side of the status bar says about the AI (spec: ai-assistant › AI status). */
function completionsText(): string {
  const { settings } = useAiSettings.getState();
  if (!settings.enabled) return "AI: off";
  if (completionsPaused()) return "Completions: paused (provider error)";
  const route = settings.routing.inline;
  if (!route) return "Completions: off";
  if (route === "copilot") {
    return useCopilot.getState().phase === "in" && settings.copilot.inline
      ? "Copilot: completions on"
      : "Completions: off";
  }
  const p = settings.providers.find((x) => x.id === route);
  return p ? `${p.name}: completions on` : "Completions: off";
}

function StatusAi() {
  useAiSettings();
  useCopilot();
  useCompletionState();
  const m = currentModel();
  const open = () => useSettings.getState().openDialog("AI assistant");
  const enabled = useAiSettings.getState().settings.enabled;
  return (
    <>
      <button type="button" className={styles.statusButton} onClick={open}>
        {completionsText()}
      </button>
      {enabled && m ? (
        <button type="button" className={styles.statusButton} onClick={open}>
          Chat: {modelLabel(m.cfg, m.model)}
        </button>
      ) : null}
    </>
  );
}

function toggle() {
  const layout = useLayout.getState();
  if (layout.sidePanelOpen) {
    layout.closeSidePanel();
    return;
  }
  layout.openSidePanel();
  // After the panel has rendered.
  setTimeout(focusComposer, 0);
}

/** The AI assistant: panel, toolbar toggle, shortcuts, status items. Returns a disposer. */
export function registerAiFeature(): () => void {
  const disposers = [
    registerSidePanel({
      id: AI_PANEL_ID,
      title: "AI assistant",
      icon: Star,
      render: () => <AiPanel />,
      headerLeft: () => <Tabs />,
      headerRight: () => <NewChat />,
      toggle: { label: "AI", shortcut: "Mod+I" },
    }),
    registerCommand({
      id: "ai.toggle",
      title: "Toggle AI assistant",
      category: "AI",
      shortcut: "Mod+I",
      run: toggle,
    }),
    registerCommand({
      id: "ai.askSelection",
      title: "Ask AI about selection",
      category: "AI",
      shortcut: "Mod+Shift+I",
      run: () => {
        const id = assistantConnection();
        useLayout.getState().openSidePanel();
        useChat.getState().setView("chat");
        const c = id ? consoleContext(id) : null;
        if (id && c?.selection && c.statement.trim()) {
          const lines = c.lines;
          useChat.getState().setComposer(id, {
            attachments: [
              {
                kind: "selection",
                label: lines ? `console · lines ${lines[0]}–${lines[1]}` : "selection",
                text: c.statement,
              },
            ],
          });
        }
        setTimeout(focusComposer, 0);
      },
    }),
    registerCommand({
      id: "ai.fix",
      title: "Fix with AI",
      category: "AI",
      shortcut: "Mod+Alt+F",
      run: () => fixWithAi("fix"),
    }),
    registerCommand({
      id: "ai.explainError",
      title: "Explain error with AI",
      category: "AI",
      run: () => fixWithAi("explain"),
    }),
    registerStatusItem({
      id: "ai.status",
      side: "right",
      order: 10,
      render: () => <StatusAi />,
    }),
  ];
  return () => disposers.forEach((d) => d());
}

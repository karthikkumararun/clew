import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { clamp } from "../../lib/clamp";
import { useConnections } from "../../connections/connectionsStore";
import type { Tab } from "../../shell/registry/tabKinds";
import { useSettings } from "../../stores/settingsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { rerunActive } from "./commands";
import { useExtensionTarget } from "./completionTarget";
import { useStore } from "zustand";
import { diagnosticsExtension, showErrorMarks } from "./editor/diagnostics";
import { Editor } from "./editor/Editor";
import { getView } from "./editor/views";
import { HistoryPanel } from "./HistoryPanel";
import { ResultsPanel } from "./ResultsPanel";
import { getRuntime } from "./runtime";
import { submitRun } from "./run";
import type { ConsoleState } from "./state";
import { useConsoleUi } from "./ui";
import styles from "./Console.module.css";

const DEFAULT_RESULTS = 320;
const MIN_RESULTS = 120;
const MIN_EDITOR = 120;
const KEY_STEP = 24;

/** The console: SQL editor, a draggable splitter and the results panel. */
export function ConsoleView({ tab }: { tab: Tab<ConsoleState> }) {
  const connection = useConnections((s) =>
    s.file.connections.find((c) => c.id === tab.state.connectionId),
  );
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const completion = useExtensionTarget(tab.id);
  const runtime = useMemo(
    () => getRuntime(tab.id, tab.state.connectionId),
    [tab.id, tab.state.connectionId],
  );
  const extensions = useMemo(
    () => [completion.extension, diagnosticsExtension],
    [completion.extension],
  );
  const marks = useStore(runtime.store, (s) => s.marks);
  // Underline where the last run failed; clear the underlines when a new run starts.
  useEffect(() => {
    const view = getView(tab.id);
    if (view) showErrorMarks(view, marks);
  }, [tab.id, marks]);
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const stored = tab.state.resultsHeight ?? DEFAULT_RESULTS;
  const height = dragHeight ?? stored;

  const limit = useCallback((h: number) => {
    const total = container.current?.clientHeight ?? 0;
    // Without layout (tests) there is nothing to clamp against.
    return total > 0
      ? clamp(Math.round(h), MIN_RESULTS, Math.max(MIN_RESULTS, total - MIN_EDITOR))
      : Math.max(MIN_RESULTS, Math.round(h));
  }, []);

  const commit = useCallback(
    (h: number) => {
      setDragHeight(null);
      useWorkspace
        .getState()
        .updateTabState<Partial<ConsoleState>>(tab.id, { resultsHeight: limit(h) });
    },
    [tab.id, limit],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startY: e.clientY, startHeight: height };
    setDragHeight(height);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) setDragHeight(limit(d.startHeight - (e.clientY - d.startY)));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    commit(limit(d.startHeight - (e.clientY - d.startY)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp") commit(height + KEY_STEP);
    else if (e.key === "ArrowDown") commit(height - KEY_STEP);
    else return;
    e.preventDefault();
  };

  if (!connection) {
    return (
      <div className={styles.missing} role="alert">
        The connection for this console no longer exists.
      </div>
    );
  }
  return (
    <div ref={container} className={styles.console} data-shortcut-scope="editor">
      <div className={styles.editorPane}>
        <Editor
          tabId={tab.id}
          driver={connection.driver}
          value={tab.state.text}
          fontSize={fontSize}
          onChange={(text) =>
            useWorkspace.getState().updateTabState<Partial<ConsoleState>>(tab.id, { text })
          }
          onCursor={(line, col) => useConsoleUi.getState().setCursor(tab.id, line, col)}
          extensions={extensions}
          onReady={(view) => {
            completion.onReady(view);
            showErrorMarks(view, runtime.store.getState().marks);
          }}
          onRunStatement={(r) =>
            void submitRun(tab, { sql: r.text, script: false, offset: r.from })
          }
        />
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize results"
        aria-valuemin={MIN_RESULTS}
        aria-valuenow={height}
        tabIndex={0}
        className={styles.split}
        data-dragging={dragHeight !== null}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <div className={styles.resultsHost} style={{ height }}>
        <ResultsPanel
          runtime={runtime}
          onRerun={() => void rerunActive()}
          history={
            <HistoryPanel
              tabId={tab.id}
              connectionId={connection.id}
              connectionName={connection.name}
            />
          }
        />
      </div>
    </div>
  );
}

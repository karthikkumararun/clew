import { useConnections } from "../../connections/connectionsStore";
import { registerShortcut } from "../../shell/registry/shortcuts";
import { useWorkspace } from "../../stores/workspaceStore";
import { askChoice } from "../console/prompts";
import { breakdown } from "./PendingBar";
import { peekTableRuntime } from "./runtime";
import type { TableRuntime } from "./runtime";
import { TABLE_KIND } from "./state";

/** Why a table can't be edited, or `null` when it can (and `undefined` while that is unknown). */
export function readOnlyReason(
  runtime: TableRuntime,
  opts: { isTable: boolean; connectionReadOnly: boolean },
): string | null | undefined {
  if (!opts.isTable) return "Read-only: views can't be edited";
  if (opts.connectionReadOnly) return "Read-only: this connection is read-only";
  const s = runtime.store.getState();
  if (!s.meta) return undefined;
  if (!s.keyColumns) return "Read-only: result has no unique key";
  return null;
}

/** Submit the staged edits, asking first on connections that confirm writes. */
export async function submitChanges(runtime: TableRuntime): Promise<boolean> {
  const counts = runtime.changes.counts();
  if (counts.total === 0) return true;
  const conn = useConnections
    .getState()
    .file.connections.find((c) => c.id === runtime.connectionId);
  if (conn?.safeguards.confirmWrites) {
    const answer = await askChoice({
      title: `Write to ${conn.name}?`,
      body: (
        <p>
          {counts.total} {counts.total === 1 ? "change" : "changes"} ({breakdown(counts)}) will be
          written to <strong>{conn.name}</strong> in one transaction.
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "submit", label: "Submit", variant: "primary" },
      ],
    });
    if (answer !== "submit") return false;
  }
  return runtime.submit();
}

/**
 * Leaving the rows these edits belong to (another page, filter, closing): ask what to do with
 * them. Resolves true when it is fine to go on.
 */
export async function confirmPending(runtime: TableRuntime): Promise<boolean> {
  const counts = runtime.changes.counts();
  if (counts.total === 0) return true;
  const answer = await askChoice({
    title: "Pending changes",
    body: (
      <p>
        This table has {counts.total} pending {counts.total === 1 ? "change" : "changes"} (
        {breakdown(counts)}). Submit them, discard them, or stay here?
      </p>
    ),
    choices: [
      { id: "cancel", label: "Cancel" },
      { id: "discard", label: "Discard" },
      { id: "submit", label: "Submit", variant: "primary" },
    ],
  });
  if (answer === "discard") {
    runtime.changes.clear();
    return true;
  }
  if (answer === "submit") return submitChanges(runtime);
  return false;
}

const typing = () => {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
};

function activeTable() {
  const { activeTabId, tabs } = useWorkspace.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  return tab && tab.kind === TABLE_KIND
    ? (tab as { id: string; state: { record: boolean } })
    : undefined;
}

/** The runtime of the table tab on screen, when editing can happen there. */
function activeEditable(): TableRuntime | undefined {
  const { activeTabId, tabs } = useWorkspace.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab || tab.kind !== TABLE_KIND) return undefined;
  const r = peekTableRuntime(tab.id);
  return r && r.editable ? r : undefined;
}

/** Keyboard shortcuts for the table editor's staged changes. Returns a disposer. */
export function registerTableShortcuts(): () => void {
  const grid = (id: string, keys: string, run: (r: TableRuntime) => void, canType = false) =>
    registerShortcut({
      id,
      keys,
      scope: "grid",
      when: () => (canType || !typing()) && activeEditable() !== undefined,
      run: () => run(activeEditable()!),
    });
  const offs = [
    grid("table.addRow", "Mod+N", (r) => void r.changes.addRow()),
    grid("table.deleteRows", "Mod+Backspace", (r) => {
      const rows = r.selectedRows;
      if (rows.length > 0) r.changes.deleteRows(rows);
    }),
    grid("table.undo", "Mod+Z", (r) => void r.changes.undo()),
    grid("table.redo", "Mod+Shift+Z", (r) => void r.changes.redo()),
    grid("table.submit", "Mod+S", (r) => void submitChanges(r), true),
    registerShortcut({
      id: "table.record",
      keys: "Mod+Shift+R",
      scope: "grid",
      when: () => activeTable() !== undefined,
      run: () => {
        const tab = activeTable();
        if (tab) {
          useWorkspace
            .getState()
            .updateTabState<{ record: boolean }>(tab.id, { record: !tab.state.record });
        }
      },
    }),
  ];
  return () => offs.forEach((o) => o());
}

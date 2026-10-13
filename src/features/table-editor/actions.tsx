import { registerShortcut } from "../../shell/registry/shortcuts";
import { registerEditTarget } from "../grid/editTarget";
import { useWorkspace } from "../../stores/workspaceStore";
import { askChoice } from "../console/prompts";
import { breakdown } from "./PendingBar";
import { peekTableRuntime } from "./runtime";
import type { TableRuntime } from "./runtime";
import { TABLE_KIND } from "./state";

/** Why a table can't be edited, or `null` when it can (and `undefined` while that is unknown). */
export function readOnlyReason(
  runtime: TableRuntime,
  opts: { isTable: boolean; sessionReadOnly: boolean },
): string | null | undefined {
  if (!opts.isTable) return "Read-only: views can't be edited";
  if (opts.sessionReadOnly) return "Read-only: this session is read-only";
  const s = runtime.store.getState();
  if (!s.meta) return undefined;
  if (!s.keyColumns) return "Read-only: result has no unique key";
  return null;
}

/**
 * Submit the staged edits. The guard (in Rust) refuses them on a read-only session and asks for
 * confirmation where the connection needs it.
 */
export function submitChanges(runtime: TableRuntime): Promise<boolean> {
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

/**
 * The table editor as an editing surface: the shared grid shortcuts (`editShortcuts.ts`) act on
 * the table tab on screen through this provider, plus the table's own Mod+Shift+R record panel.
 */
export function registerTableShortcuts(): () => void {
  const offTarget = registerEditTarget(() => {
    const r = activeEditable();
    if (!r) return undefined;
    return {
      submitsWithEnter: false,
      addRow: () => void r.changes.addRow(),
      cloneRows: () => {},
      deleteRows: () => {
        if (r.selectedRows.length > 0) r.changes.deleteRows(r.selectedRows);
      },
      undo: () => void r.changes.undo(),
      redo: () => void r.changes.redo(),
      revertSelection: () => {},
      setNull: () => {},
      setDefault: () => {},
      submit: () => void submitChanges(r),
    };
  });
  const offRecord = registerShortcut({
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
  });
  return () => {
    offTarget();
    offRecord();
  };
}

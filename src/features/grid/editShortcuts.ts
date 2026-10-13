import { registerShortcut } from "../../shell/registry/shortcuts";
import { activeEditTarget } from "./editTarget";
import type { GridEditTarget } from "./editTarget";

const typing = () => {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
};

/**
 * The grid-scope editing shortcuts (spec: result-editing › Result shortcuts), bound once and
 * handed to the editing surface that is on screen. `Mod+Enter` is bound in the grid scope only:
 * with focus in the SQL editor the editor scope's Mod+Enter still runs the statement.
 */
export function registerGridEditShortcuts(): () => void {
  const bind = (
    id: string,
    keys: string,
    run: (t: GridEditTarget) => void,
    opts: { canType?: boolean; needs?: (t: GridEditTarget) => boolean } = {},
  ) =>
    registerShortcut({
      id,
      keys,
      scope: "grid",
      when: () => {
        if (!opts.canType && typing()) return false;
        const t = activeEditTarget();
        return t !== undefined && (opts.needs?.(t) ?? true);
      },
      run: () => run(activeEditTarget()!),
    });
  const offs = [
    bind("grid.addRow", "Mod+N", (t) => t.addRow()),
    bind("grid.cloneRows", "Mod+Shift+D", (t) => t.cloneRows()),
    bind("grid.deleteRows", "Mod+Backspace", (t) => t.deleteRows()),
    bind("grid.undo", "Mod+Z", (t) => t.undo()),
    bind("grid.redo", "Mod+Shift+Z", (t) => t.redo()),
    bind("grid.revertSelection", "Mod+Alt+Z", (t) => t.revertSelection()),
    bind("grid.setNull", "Mod+Alt+N", (t) => t.setNull()),
    bind("grid.setDefault", "Mod+Alt+D", (t) => t.setDefault()),
    bind("grid.submit", "Mod+S", (t) => t.submit(), {
      canType: true,
      needs: (t) => !t.submitsWithEnter,
    }),
    bind("grid.submitEnter", "Mod+Enter", (t) => t.submit(), {
      needs: (t) => t.submitsWithEnter,
    }),
    bind("grid.submitCommit", "Mod+Alt+Shift+Enter", (t) => t.submitAndCommit?.(), {
      needs: (t) => t.submitAndCommit !== undefined,
    }),
    bind("grid.paste", "Mod+V", (t) => t.paste?.(false), { needs: (t) => t.paste !== undefined }),
    bind("grid.pasteNew", "Mod+Shift+V", (t) => t.paste?.(true), {
      needs: (t) => t.paste !== undefined,
    }),
  ];
  return () => offs.forEach((o) => o());
}

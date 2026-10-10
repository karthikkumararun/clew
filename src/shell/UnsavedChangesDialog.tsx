import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { useWorkspace } from "../stores/workspaceStore";
import { getTabKind } from "./registry/tabKinds";

/** Save / Discard / Cancel prompt shown when closing a tab with unsaved changes. */
export function UnsavedChangesDialog() {
  const closeRequest = useWorkspace((s) => s.closeRequest);
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === s.closeRequest));
  const resolve = useWorkspace((s) => s.resolveCloseRequest);
  if (!closeRequest || !tab) return null;
  const kind = getTabKind(tab.kind);
  const title = kind?.title(tab.state) ?? tab.key;
  return (
    <Dialog
      title="Unsaved changes"
      maxWidth={440}
      onClose={() => void resolve("cancel")}
      footer={
        <>
          <Button variant="default" onClick={() => void resolve("cancel")}>
            Cancel
          </Button>
          <Button variant="default" onClick={() => void resolve("discard")}>
            Discard
          </Button>
          {kind?.save ? (
            <Button variant="primary" onClick={() => void resolve("save")}>
              Save
            </Button>
          ) : null}
        </>
      }
    >
      <p style={{ margin: 0, padding: "20px", lineHeight: 1.5 }}>
        <strong>{title}</strong> has unsaved changes. Save them before closing?
      </p>
    </Dialog>
  );
}

import { useRef, useState } from "react";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { EnvDot } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Input } from "../../components/Input";
import { Menu } from "../../components/Menu";
import type { MenuItem } from "../../components/Menu";
import { ChevronDown } from "../../components/icons";
import { useWorkspace } from "../../stores/workspaceStore";
import { askChoice } from "../console/prompts";
import { ENV_LABEL, groupByEnvironment } from "./model";
import type { WorkspaceEnv, WorkspaceRow } from "./model";
import {
  duplicate,
  newWorkspace,
  remove,
  rename,
  saveAs,
  switchTo,
  useWorkspaces,
  workspaceRows,
} from "./store";
import styles from "./Workspaces.module.css";

const tabs = (n: number) => `${n} ${n === 1 ? "tab" : "tabs"}`;

function EnvMark({ env }: { env: WorkspaceEnv }) {
  return env === "mixed" ? null : <EnvDot env={env} size={8} />;
}

/** The menu entries: a heading per environment, then its workspaces, then the actions. */
export function switcherItems(rows: WorkspaceRow[], activeId: string): MenuItem[] {
  const items: MenuItem[] = [];
  for (const group of groupByEnvironment(rows)) {
    items.push({
      id: `h:${group.env}`,
      label: <span className={styles.heading}>{ENV_LABEL[group.env]}</span>,
      disabled: true,
      separatorBefore: items.length > 0,
    });
    for (const r of group.rows) {
      items.push({
        id: `ws:${r.meta.id}`,
        label: (
          <span className={styles.row}>
            <span aria-hidden="true">{r.meta.id === activeId ? "✓" : " "}</span>
            <EnvMark env={r.env} />
            {r.meta.name}
          </span>
        ),
        hint: tabs(r.tabCount),
      });
    }
  }
  items.push(
    { id: "new", label: "New workspace…", separatorBefore: true },
    { id: "save-as", label: "Save workspace as…" },
    { id: "manage", label: "Manage workspaces…" },
  );
  return items;
}

/** The toolbar switcher (spec: workspaces › Switching workspaces, Environment grouping). */
export function WorkspaceSwitcher() {
  const { activeId, menuOpen, setMenuOpen, setSaveAsOpen, setManageOpen, setNewOpen } =
    useWorkspaces();
  const anchor = useRef<HTMLButtonElement>(null);
  // Re-render with the live tabs so the active workspace's environment is current.
  useWorkspace((s) => s.tabs);
  const rows = workspaceRows();
  const current = rows.find((r) => r.meta.id === activeId) ?? rows[0];
  const close = () => {
    setMenuOpen(false);
    anchor.current?.focus();
  };
  const pick = (id: string) => {
    close();
    if (id === "new") setNewOpen(true);
    else if (id === "save-as") setSaveAsOpen(true);
    else if (id === "manage") setManageOpen(true);
    else if (id.startsWith("ws:")) void switchTo(id.slice(3));
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.button}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <span className="sr-only">Workspace </span>
        <EnvMark env={current.env} />
        <span className={styles.name}>{current.meta.name}</span>
        <ChevronDown size={10} />
      </button>
      {menuOpen ? (
        <AnchoredMenu anchor={anchor}>
          <Menu
            aria-label="Workspaces"
            items={switcherItems(rows, activeId)}
            onSelect={pick}
            onClose={close}
          />
        </AnchoredMenu>
      ) : null}
      <WorkspaceDialogs />
    </>
  );
}

function NameDialog({
  title,
  initial,
  action,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  action: string;
  onSubmit: (name: string) => string | null | Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const problem = await onSubmit(name);
    if (problem) setError(problem);
    else onClose();
  };
  return (
    <Dialog
      title={title}
      maxWidth={420}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()}>
            {action}
          </Button>
        </>
      }
    >
      <div className={styles.field}>
        <label htmlFor="workspace-name">Workspace name</label>
        <Input
          id="workspace-name"
          dialog
          value={name}
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function ManageDialog({ onClose }: { onClose: () => void }) {
  useWorkspaces((s) => s.items);
  const activeId = useWorkspaces((s) => s.activeId);
  const [renaming, setRenaming] = useState<string | null>(null);
  const rows = workspaceRows();

  const confirmDelete = async (r: WorkspaceRow) => {
    const active = r.meta.id === activeId;
    const answer = await askChoice({
      title: `Delete "${r.meta.name}"?`,
      body: active
        ? "Its tabs stay open and continue as the Last session."
        : "The workspace and its saved tabs are removed. Your files are not touched.",
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "delete", label: "Delete", variant: "primary" },
      ],
    });
    if (answer === "delete") remove(r.meta.id);
  };

  return (
    <Dialog
      title="Manage workspaces"
      maxWidth={560}
      onClose={onClose}
      footer={
        <Button variant="default" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className={styles.manage} role="list" aria-label="Workspaces">
        {rows.map((r) => (
          <div key={r.meta.id} className={styles.manageRow} role="listitem">
            <EnvMark env={r.env} />
            <span className={styles.manageName}>
              {r.meta.name}
              {r.meta.id === activeId ? <span className={styles.muted}> · open</span> : null}
            </span>
            <span className={styles.muted}>{tabs(r.tabCount)}</span>
            {r.meta.kind !== "last" ? (
              <>
                <Button variant="default" onClick={() => setRenaming(r.meta.id)}>
                  Rename
                </Button>
                <Button variant="default" onClick={() => duplicate(r.meta.id)}>
                  Duplicate
                </Button>
                <Button variant="default" onClick={() => void confirmDelete(r)}>
                  Delete
                </Button>
              </>
            ) : null}
          </div>
        ))}
      </div>
      {renaming ? (
        <NameDialog
          title="Rename workspace"
          initial={rows.find((r) => r.meta.id === renaming)?.meta.name ?? ""}
          action="Rename"
          onSubmit={(name) => {
            const r = rename(renaming, name);
            return r.ok ? null : r.error;
          }}
          onClose={() => setRenaming(null)}
        />
      ) : null}
    </Dialog>
  );
}

/** Save as… and Manage…, mounted next to the switcher. */
function WorkspaceDialogs() {
  const { saveAsOpen, manageOpen, newOpen, setSaveAsOpen, setManageOpen, setNewOpen } =
    useWorkspaces();
  return (
    <>
      {newOpen ? (
        <NameDialog
          title="New workspace"
          initial=""
          action="Create"
          onSubmit={async (name) => {
            const r = await newWorkspace(name);
            return r.ok ? null : r.error;
          }}
          onClose={() => setNewOpen(false)}
        />
      ) : null}
      {saveAsOpen ? (
        <NameDialog
          title="Save workspace as"
          initial=""
          action="Save"
          onSubmit={(name) => {
            const r = saveAs(name);
            return r.ok ? null : r.error;
          }}
          onClose={() => setSaveAsOpen(false)}
        />
      ) : null}
      {manageOpen ? <ManageDialog onClose={() => setManageOpen(false)} /> : null}
    </>
  );
}

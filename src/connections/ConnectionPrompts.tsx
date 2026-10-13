import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { Input } from "../components/Input";
import { rowsOf } from "../features/sessions/OpenTransactionsDialog";
import { isTauri } from "../lib/ipc";
import { useSessions } from "../stores/sessionsStore";
import type { HostKeyPrompt } from "../lib/ipc/generated/HostKeyPrompt";
import { hostKeyAnswer } from "../lib/ipc/drivers";
import { onHostKeyPromptEvent, onPasswordPrompt, passwordAnswer } from "./api";
import type { PasswordPrompt } from "./api";
import { useConnections } from "./connectionsStore";
import styles from "./ConnectionList.module.css";

function NamePrompt({
  title,
  label,
  initial,
  confirm,
  onSubmit,
}: {
  title: string;
  label: string;
  initial: string;
  confirm: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const close = () => useConnections.getState().setModal(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <Dialog title={title} maxWidth={420} onClose={close}>
      <form className={styles.prompt} onSubmit={submit}>
        <label htmlFor="name-prompt">{label}</label>
        <Input
          id="name-prompt"
          dialog
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          autoComplete="off"
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!value.trim()}>
            {confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Confirm({
  title,
  body,
  actions,
}: {
  title: string;
  body: React.ReactNode;
  actions: { label: string; variant?: "default" | "primary"; onClick: () => void }[];
}) {
  return (
    <Dialog
      title={title}
      maxWidth={460}
      onClose={() => useConnections.getState().setModal(null)}
      footer={actions.map((a) => (
        <Button key={a.label} variant={a.variant ?? "default"} onClick={a.onClick}>
          {a.label}
        </Button>
      ))}
    >
      <div className={styles.prompt}>{body}</div>
    </Dialog>
  );
}

/** The sessions of a connection that hold a transaction (session, duration, statements). */
function OpenSessionsList({ connectionId }: { connectionId: string }) {
  const sessions = useSessions((s) => s.sessions);
  const rows = rowsOf(Object.values(sessions).filter((x) => x.connectionId === connectionId));
  if (rows.length === 0) return null;
  return (
    <ul aria-label="Sessions in a transaction">
      {rows.map((r) => (
        <li key={r.id}>
          {r.name} · open {r.duration} · {r.statements}
        </li>
      ))}
    </ul>
  );
}

/** Confirmations and name prompts raised from the connection list. */
export function ConnectionModals() {
  const { modal, file, setModal } = useConnections();
  const s = useConnections.getState();
  if (!modal) return null;
  const conn = "id" in modal ? file.connections.find((c) => c.id === modal.id) : undefined;
  const group = "id" in modal ? file.groups.find((g) => g.id === modal.id) : undefined;
  const cancel = { label: "Cancel", onClick: () => setModal(null) };

  switch (modal.kind) {
    case "delete":
      return conn ? (
        <Confirm
          title="Delete connection"
          body={
            <p>
              Delete <strong>{conn.name}</strong>? Its saved passwords are removed from the keychain
              and its open tabs are closed. This can&apos;t be undone.
            </p>
          }
          actions={[
            cancel,
            { label: "Delete", variant: "primary", onClick: () => void s.confirmDelete(conn.id) },
          ]}
        />
      ) : null;
    case "transactions":
      return conn ? (
        <Confirm
          title="Uncommitted transaction"
          body={
            <>
              <p>
                <strong>{conn.name}</strong> has {modal.sessions === 1 ? "a console" : "consoles"}{" "}
                with an open transaction. Commit or roll back before disconnecting?
              </p>
              <OpenSessionsList connectionId={conn.id} />
            </>
          }
          actions={[
            cancel,
            { label: "Roll back all", onClick: () => void s.disconnect(conn.id, "rollback") },
            {
              label: "Commit all",
              variant: "primary",
              onClick: () => void s.disconnect(conn.id, "commit"),
            },
          ]}
        />
      ) : null;
    case "rename":
      return conn ? (
        <NamePrompt
          title="Rename connection"
          label="Name"
          initial={conn.name}
          confirm="Rename"
          onSubmit={(name) => void s.rename(conn.id, name)}
        />
      ) : null;
    case "folderRename":
      return conn ? (
        <Confirm
          title="Rename Scripts folder?"
          body={
            <p>
              Also rename <code>{modal.offer.from}</code> to <code>{modal.offer.to}</code>? Linked
              SQL files stay linked either way.
            </p>
          }
          actions={[
            {
              label: "Keep folder",
              onClick: () => void s.finishFolderRename(conn.id, modal.offer, false),
            },
            {
              label: "Rename folder",
              variant: "primary",
              onClick: () => void s.finishFolderRename(conn.id, modal.offer, true),
            },
          ]}
        />
      ) : null;
    case "newGroup":
      return (
        <NamePrompt
          title="New group"
          label="Group name"
          initial=""
          confirm="Create"
          onSubmit={(name) => void s.createGroup(name, modal.moveConnectionId)}
        />
      );
    case "renameGroup":
      return group ? (
        <NamePrompt
          title="Rename group"
          label="Group name"
          initial={group.name}
          confirm="Rename"
          onSubmit={(name) => void s.renameGroup(group.id, name)}
        />
      ) : null;
    case "deleteGroup":
      return group ? (
        <Confirm
          title="Delete group"
          body={
            <p>
              Delete the group <strong>{group.name}</strong>? Its connections move to Ungrouped.
            </p>
          }
          actions={[
            cancel,
            { label: "Delete", variant: "primary", onClick: () => void s.deleteGroup(group.id) },
          ]}
        />
      ) : null;
  }
}

function PasswordDialog({ prompt, done }: { prompt: PasswordPrompt; done: () => void }) {
  const [value, setValue] = useState("");
  const answer = (password: string | null) => {
    void passwordAnswer(prompt.promptId, password).catch(() => {});
    done();
  };
  const what = prompt.purpose === "ssh" ? "SSH password or passphrase" : "Password";
  return (
    <Dialog
      title={`${what} for ${prompt.connectionName}`}
      maxWidth={420}
      onClose={() => answer(null)}
    >
      <form
        className={styles.prompt}
        onSubmit={(e) => {
          e.preventDefault();
          answer(value);
        }}
      >
        <label htmlFor="pw-prompt">{prompt.user ? `${what} for ${prompt.user}` : what}</label>
        <Input
          id="pw-prompt"
          dialog
          mono
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
        <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-small)" }}>
          It is kept in memory until the connection is closed and is not saved.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="default" onClick={() => answer(null)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Connect
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function HostKeyDialog({ prompt, done }: { prompt: HostKeyPrompt; done: () => void }) {
  const answer = (accept: boolean) => {
    void hostKeyAnswer(prompt.promptId, accept).catch(() => {});
    done();
  };
  return (
    <Dialog title="Unknown SSH host" maxWidth={480} onClose={() => answer(false)}>
      <div className={styles.prompt}>
        <p>
          The authenticity of{" "}
          <strong>
            {prompt.host}:{prompt.port}
          </strong>{" "}
          can&apos;t be established. Check the fingerprint with the server&apos;s administrator
          before trusting it.
        </p>
        <div className={styles.fingerprint}>
          {prompt.keyType}
          <br />
          {prompt.fingerprint}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="default" onClick={() => answer(false)}>
            Reject
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            Trust and continue
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Dialogs the backend raises while connecting: password entry and unknown SSH host keys. */
export function ConnectionPromptHost() {
  const [passwords, setPasswords] = useState<PasswordPrompt[]>([]);
  const [hostKeys, setHostKeys] = useState<HostKeyPrompt[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    const offs: (() => void)[] = [];
    let live = true;
    void onPasswordPrompt((p) => setPasswords((l) => [...l, p])).then((off) =>
      live ? offs.push(off) : off(),
    );
    void onHostKeyPromptEvent((p) => setHostKeys((l) => [...l, p])).then((off) =>
      live ? offs.push(off) : off(),
    );
    return () => {
      live = false;
      offs.forEach((o) => o());
    };
  }, []);

  const hostKey = hostKeys[0];
  const password = passwords[0];
  return (
    <>
      {hostKey ? (
        <HostKeyDialog
          key={hostKey.promptId}
          prompt={hostKey}
          done={() => setHostKeys((l) => l.slice(1))}
        />
      ) : null}
      {!hostKey && password ? (
        <PasswordDialog
          key={password.promptId}
          prompt={password}
          done={() => setPasswords((l) => l.slice(1))}
        />
      ) : null}
    </>
  );
}

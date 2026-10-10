import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Checkbox, Input, Select } from "../components/Input";
import { Dialog } from "../components/Dialog";
import { Check, Warning } from "../components/icons";
import { ENV_COLORS } from "../components/Badge";
import type { Environment as BadgeEnv } from "../components/Badge";
import { registerShortcut } from "../shell/registry/shortcuts";
import { runCommand } from "../shell/registry/commands";
import { driversList } from "../lib/ipc/drivers";
import { isAppError } from "../lib/ipc/drivers";
import { connectionSecretStatus, connectionsTest, connectionsTestCancel } from "./api";
import type { SecretStatus } from "./api";
import { CATALOG } from "./catalog";
import type { CatalogDriver } from "./catalog";
import { useConnections } from "./connectionsStore";
import type { DialogRequest } from "./connectionsStore";
import {
  ENVIRONMENTS,
  buildUrl,
  setEnvironment,
  switchDriver,
  tabOfError,
  toSaveRequest,
  validate,
} from "./draft";
import type { Draft, Errors } from "./draft";
import { AdvancedTab, SshTab, TlsTab } from "./ExtraTabs";
import { GeneralForm } from "./GeneralForms";
import { pickFile } from "./files";
import styles from "./ConnectionDialog.module.css";

type TabId = "general" | "ssh" | "tls" | "advanced";
const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "ssh", label: "SSH tunnel" },
  { id: "tls", label: "SSL / TLS" },
  { id: "advanced", label: "Advanced" },
];

const NEW_GROUP = "__new__";
const SLOW_TEST_MS = 2000;

const ENV_TOKEN: Record<string, BadgeEnv> = {
  local: "local",
  development: "dev",
  staging: "staging",
  production: "production",
};

type TestState =
  | { phase: "idle" }
  | { phase: "running"; id: string; slow: boolean }
  | { phase: "ok"; text: string }
  | { phase: "error"; message: string; detail?: string; showDetail: boolean };

let testCounter = 0;

function DriverList({
  selected,
  available,
  onPick,
}: {
  selected: string;
  available: Set<string> | null;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const match = (d: CatalogDriver) => !q || d.name.toLowerCase().includes(q) || d.id.includes(q);
  const section = (title: string, family: "sql" | "nosql") => {
    const items = CATALOG.filter((d) => d.family === family && match(d));
    if (items.length === 0) return null;
    return (
      <>
        <div className={styles.groupLabel}>{title}</div>
        {items.map((d) => {
          const unavailable = available !== null && !available.has(d.id);
          return (
            <button
              key={d.id}
              type="button"
              className={styles.driver}
              aria-pressed={d.id === selected}
              disabled={unavailable}
              onClick={() => onPick(d.id)}
            >
              <span className={styles.badge} style={{ background: d.color }}>
                {d.badge}
              </span>
              {d.name}
              {unavailable ? <span className={styles.soon}>soon</span> : null}
            </button>
          );
        })}
      </>
    );
  };
  return (
    <div className={styles.drivers}>
      <label htmlFor="drv-search" className={styles.srOnly}>
        Search drivers
      </label>
      <Input
        id="drv-search"
        dialog
        className={styles.search}
        placeholder="Search drivers…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />
      {section("SQL", "sql")}
      {section("NoSQL", "nosql")}
      <div className={styles.spacer} />
      <p className={styles.pluginNote}>Drivers marked “soon” arrive in a later release.</p>
    </div>
  );
}

export function ConnectionDialog({ request }: { request: DialogRequest }) {
  const { file, save, closeDialog } = useConnections();
  const [draft, setDraft] = useState<Draft>(request.initial);
  const [tab, setTab] = useState<TabId>("general");
  const [errors, setErrors] = useState<Errors>({});
  const [available, setAvailable] = useState<Set<string> | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [groupChoice, setGroupChoice] = useState<string>(request.initial.groupId ?? "");
  const [newGroup, setNewGroup] = useState("");
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nameRef = useRef<HTMLInputElement>(null);

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setTest((t) => (t.phase === "running" ? t : { phase: "idle" }));
  };

  useEffect(() => {
    let live = true;
    driversList()
      .then((groups) => {
        if (live) setAvailable(new Set(groups.flatMap((g) => g.drivers.map((d) => d.id))));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!request.initial.id) return;
    let live = true;
    connectionSecretStatus(request.initial.id)
      .then((s) => live && setSecrets(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [request.initial.id]);

  useEffect(() => {
    // The Dialog focuses its first control (Close) on open; Name is the better start.
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => () => clearTimeout(slowTimer.current), []);

  const url = useMemo(() => buildUrl(draft), [draft]);
  const prod = draft.environment === "production";

  const submit = async (connect: boolean) => {
    if (saving) return;
    const found = validate(draft);
    setErrors(found);
    const bad = tabOfError(found);
    if (bad) {
      setTab(bad);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await save(
        { ...draft, groupId: groupChoice && groupChoice !== NEW_GROUP ? groupChoice : null },
        groupChoice === NEW_GROUP ? newGroup : undefined,
      );
      closeDialog();
      if (connect) void runCommand("connection.open", saved.id);
    } catch (e) {
      setSaveError(isAppError(e) ? e.message : "Couldn't save the connection");
      setSaving(false);
    }
  };

  // Mod+Enter saves. Registered through the shortcut registry; always runs the latest submit.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(
    () =>
      registerShortcut({
        id: "connection-dialog.save",
        keys: "Mod+Enter",
        scope: "dialog",
        run: () => void submitRef.current(true),
      }),
    [],
  );

  const runTest = async () => {
    const found = validate(draft);
    setErrors(found);
    const bad = tabOfError(found);
    if (bad) {
      setTab(bad);
      return;
    }
    const id = `test-${++testCounter}`;
    setTest({ phase: "running", id, slow: false });
    clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(
      () => setTest((t) => (t.phase === "running" && t.id === id ? { ...t, slow: true } : t)),
      SLOW_TEST_MS,
    );
    try {
      const info = await connectionsTest(toSaveRequest(draft), id);
      const via = draft.sshEnabled && draft.sshHost ? ` via ${draft.sshHost}` : "";
      setTest((t) =>
        t.phase === "running" && t.id === id
          ? {
              phase: "ok",
              text: `Connected · ${info.product} ${info.version} · ${info.round_trip_ms} ms${via}`,
            }
          : t,
      );
    } catch (e) {
      setTest((t) => {
        if (t.phase !== "running" || t.id !== id) return t;
        if (isAppError(e) && e.code === "cancelled") return { phase: "idle" };
        return {
          phase: "error",
          message: isAppError(e) ? e.message : "The connection test failed",
          detail: isAppError(e) ? e.detail : undefined,
          showDetail: false,
        };
      });
    } finally {
      clearTimeout(slowTimer.current);
    }
  };

  const cancelTest = () => {
    if (test.phase === "running") void connectionsTestCancel(test.id).catch(() => {});
  };

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const choose = async () => {
    const path = await pickFile({
      title: "Choose a database file",
      filters: [{ name: "Database", extensions: ["db", "sqlite", "sqlite3", "duckdb", "db3"] }],
    });
    if (path) patch({ filePath: path });
  };

  const passwordSaved = Boolean(secrets?.password) && !draft.clearPassword;

  return (
    <Dialog title={request.title} onClose={closeDialog}>
      <div className={styles.layout}>
        <DriverList
          selected={draft.driver}
          available={available}
          onPick={(id) => {
            setDraft((d) => switchDriver(d, id));
            setTest({ phase: "idle" });
          }}
        />

        <div className={styles.form}>
          <div className={styles.top}>
            <div className={styles.row}>
              <div className={styles.fld}>
                <label htmlFor="c-name">Name</label>
                <Input
                  id="c-name"
                  ref={nameRef}
                  dialog
                  value={draft.name}
                  aria-invalid={Boolean(errors.name)}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      name: e.target.value,
                      nameEdited: e.target.value !== "",
                    }))
                  }
                  autoComplete="off"
                />
                {errors.name ? (
                  <span role="alert" className={styles.error}>
                    {errors.name}
                  </span>
                ) : null}
              </div>
              <div className={styles.fld}>
                <label htmlFor="c-group">Group</label>
                <Select
                  id="c-group"
                  value={groupChoice}
                  onChange={(e) => setGroupChoice(e.target.value)}
                >
                  <option value="">Ungrouped</option>
                  {file.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                  <option value={NEW_GROUP}>New group…</option>
                </Select>
                {groupChoice === NEW_GROUP ? (
                  <Input
                    dialog
                    aria-label="New group name"
                    placeholder="Group name"
                    value={newGroup}
                    onChange={(e) => setNewGroup(e.target.value)}
                  />
                ) : null}
              </div>
            </div>
            <div className={styles.fld}>
              <span className={styles.lbl}>Environment</span>
              <div role="radiogroup" aria-label="Environment" className={styles.envs}>
                {ENVIRONMENTS.map((env) => (
                  <button
                    key={env.id}
                    type="button"
                    role="radio"
                    className={styles.env}
                    aria-checked={draft.environment === env.id}
                    style={
                      draft.environment === env.id
                        ? { borderColor: ENV_COLORS[ENV_TOKEN[env.id]] }
                        : undefined
                    }
                    onClick={() => {
                      setDraft((d) => setEnvironment(d, env.id));
                      setTest({ phase: "idle" });
                    }}
                  >
                    <span
                      className={styles.envDot}
                      style={{ background: ENV_COLORS[ENV_TOKEN[env.id]] }}
                    />
                    {env.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div role="tablist" aria-label="Connection settings" className={styles.tabs}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="conn-panel"
                className={styles.tab}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div
            id="conn-panel"
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            className={styles.panel}
          >
            {tab === "general" ? (
              <>
                <GeneralForm
                  draft={draft}
                  errors={errors}
                  patch={patch}
                  setPort={(port) => patch({ port, portEdited: true })}
                  pickFile={() => void choose()}
                  passwordSaved={passwordSaved}
                />
                <div className={styles.fld}>
                  <span className={styles.lbl}>URL</span>
                  <div className={`${styles.url} mono`}>
                    <span data-testid="url-preview">{url ?? "—"}</span>
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => void copyUrl()}
                      disabled={!url}
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
            {tab === "ssh" ? <SshTab draft={draft} errors={errors} patch={patch} /> : null}
            {tab === "tls" ? <TlsTab draft={draft} errors={errors} patch={patch} /> : null}
            {tab === "advanced" ? (
              <AdvancedTab draft={draft} errors={errors} patch={patch} />
            ) : null}

            {prod ? (
              <div className={styles.safeguards} data-testid="prod-safeguards">
                <div className={styles.safeguardsTitle}>
                  <Warning size={14} />
                  Production safeguards
                </div>
                <Checkbox
                  label="Open read-only by default"
                  description="Switch to read-write per session from the toolbar."
                  checked={draft.safeguards.readOnlyByDefault}
                  onChange={(e) =>
                    patch({
                      safeguards: { ...draft.safeguards, readOnlyByDefault: e.target.checked },
                    })
                  }
                />
                <Checkbox
                  label="Confirm every write, and block UPDATE / DELETE without WHERE"
                  checked={draft.safeguards.confirmWrites}
                  onChange={(e) =>
                    patch({ safeguards: { ...draft.safeguards, confirmWrites: e.target.checked } })
                  }
                />
                <Checkbox
                  label="Manual commit (no auto-commit)"
                  checked={draft.safeguards.manualCommit}
                  onChange={(e) =>
                    patch({ safeguards: { ...draft.safeguards, manualCommit: e.target.checked } })
                  }
                />
              </div>
            ) : null}
          </div>

          <div className={styles.footer}>
            {test.phase === "running" && test.slow ? (
              <Button variant="default" onClick={cancelTest}>
                Cancel test
              </Button>
            ) : (
              <Button
                variant="default"
                onClick={() => void runTest()}
                disabled={test.phase === "running"}
              >
                {test.phase === "running" ? "Testing…" : "Test connection"}
              </Button>
            )}
            {test.phase === "ok" ? (
              <span role="status" className={`${styles.result} ${styles.ok}`}>
                <Check size={14} />
                {test.text}
              </span>
            ) : null}
            {test.phase === "error" ? (
              <>
                <span role="alert" className={`${styles.result} ${styles.fail}`}>
                  {test.message}
                </span>
                {test.detail ? (
                  <button
                    type="button"
                    className={styles.link}
                    aria-expanded={test.showDetail}
                    onClick={() => setTest({ ...test, showDetail: !test.showDetail })}
                  >
                    Details
                  </button>
                ) : null}
                {test.showDetail && test.detail ? (
                  <pre className={styles.details}>{test.detail}</pre>
                ) : null}
              </>
            ) : null}
            {saveError ? (
              <span role="alert" className={`${styles.result} ${styles.fail}`}>
                {saveError}
              </span>
            ) : null}
            <div className={styles.spacer} />
            <Button variant="default" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              variant="primary"
              className=""
              onClick={() => void submit(true)}
              disabled={saving}
            >
              Save &amp; connect
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Mounted once in the workspace; renders the dialog when the store asks for it. */
export function ConnectionDialogHost() {
  const dialog = useConnections((s) => s.dialog);
  return dialog ? <ConnectionDialog key={dialog.initial.id || "new"} request={dialog} /> : null;
}

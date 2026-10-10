import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DriverBadge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Checkbox, Input, Select } from "../../components/Input";
import { Check, File } from "../../components/icons";
import { useNotices } from "../../stores/noticesStore";
import { importClewInspect, importCommit, importDatagripDiscover, importScan } from "../api";
import type {
  CandidateView,
  CommitOptions,
  DataGripInstall,
  Environment,
  FileInfo,
  ImportResult,
  ImportSource,
  ScanView,
} from "../api";
import { useConnections } from "../connectionsStore";
import { badgeDriver } from "../display";
import { pickFile, pickFolder } from "../files";
import styles from "./ImportExport.module.css";

type SourceId = "datagrip" | "clew" | "dbeaver" | "pgpass";

const SOURCES: { id: SourceId; name: string; sub: string }[] = [
  { id: "datagrip", name: "DataGrip", sub: "Data sources, SQL consoles and scratch files" },
  { id: "clew", name: "Clew export", sub: ".clew file, encrypted or plain" },
  { id: "dbeaver", name: "DBeaver", sub: "data-sources.json" },
  { id: "pgpass", name: "~/.pgpass", sub: "PostgreSQL password file" },
];

const OTHER_NOTE: Record<"dbeaver" | "pgpass", string> = {
  dbeaver:
    "Pick a DBeaver workspace; its data-sources.json connections are listed for review, without passwords.",
  pgpass:
    'Each host:port:database:user line becomes a PostgreSQL connection; passwords go to the keychain only if you tick "Import passwords".',
};

const ENVIRONMENTS: { value: Environment; label: string }[] = [
  { value: "local", label: "Local" },
  { value: "development", label: "Development" },
  { value: "staging", label: "Staging" },
  { value: "production", label: "Production" },
];

const errorOf = (e: unknown) => e as { code?: string; message?: string };

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describeFile(info: FileInfo): string {
  const c = info.counts;
  const parts = [plural(c.connections, "connection")];
  if (info.encrypted) parts.push("encrypted passwords");
  if (c.sshKeys > 0) parts.push(plural(c.sshKeys, "SSH key"));
  if (c.sqlFiles > 0) parts.push(plural(c.sqlFiles, "SQL file"));
  return parts.join(" · ");
}

function statusLabel(c: CandidateView): { text: string; tone: "new" | "existing" | "off" } {
  if (c.status === "new") return { text: c.note ? `New · ${c.note}` : "New", tone: "new" };
  if (c.status === "existing")
    return { text: "Already in Clew · merge SQL files only", tone: "existing" };
  return { text: c.note ?? "Driver not available", tone: "off" };
}

export function ImportPanel({ onDone }: { onDone: () => void }) {
  const [source, setSource] = useState<SourceId>("datagrip");

  // DataGrip
  const [installs, setInstalls] = useState<DataGripInstall[]>([]);
  const [dgDir, setDgDir] = useState<string | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [withPasswords, setWithPasswords] = useState(false);
  const [keepassPassword, setKeepassPassword] = useState("");
  // A fresh object per submit, so retyping the same wrong password scans again.
  const [keepassSent, setKeepassSent] = useState<{ value: string } | null>(null);
  const [needsKeepass, setNeedsKeepass] = useState(false);

  // Clew file
  const [clewPath, setClewPath] = useState<string | null>(null);
  const [clewInfo, setClewInfo] = useState<FileInfo | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [unlocked, setUnlocked] = useState<string | null>(null);

  // DBeaver / pgpass
  const [dbeaverPath, setDbeaverPath] = useState<string | null>(null);
  const [pgpassPasswords, setPgpassPasswords] = useState(false);

  // Review + options
  const [scan, setScan] = useState<ScanView | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [importSql, setImportSql] = useState(true);
  const [env, setEnv] = useState<"detect" | Environment>("detect");
  const [groupMode, setGroupMode] = useState<"single" | "keep">("single");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const scanTicket = useRef(0);

  // Find DataGrip settings on this machine.
  useEffect(() => {
    let live = true;
    importDatagripDiscover()
      .then((found) => {
        if (!live) return;
        setInstalls(found);
        setDgDir((cur) => cur ?? found[0]?.path ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const sourceRequest = useCallback((): ImportSource | null => {
    switch (source) {
      case "datagrip":
        return dgDir
          ? {
              kind: "dataGrip",
              dir: dgDir,
              projects,
              includePasswords: withPasswords,
              keepassPassword: keepassSent?.value ?? null,
            }
          : null;
      case "clew":
        if (!clewPath || !clewInfo) return null;
        if (clewInfo.encrypted && unlocked === null) return null;
        return { kind: "clew", path: clewPath, passphrase: unlocked };
      case "dbeaver":
        return dbeaverPath ? { kind: "dbeaver", path: dbeaverPath } : null;
      case "pgpass":
        return { kind: "pgpass", path: null, includePasswords: pgpassPasswords };
    }
  }, [
    source,
    dgDir,
    projects,
    withPasswords,
    keepassSent,
    clewPath,
    clewInfo,
    unlocked,
    dbeaverPath,
    pgpassPasswords,
  ]);

  // Scan whenever the source changes. Nothing is written until Import.
  useEffect(() => {
    const request = sourceRequest();
    setScan(null);
    setResult(null);
    setChecked(new Set());
    if (!request) return;
    const ticket = ++scanTicket.current;
    setBusy(true);
    setError(null);
    importScan(request)
      .then((view) => {
        if (ticket !== scanTicket.current) return;
        setNeedsKeepass(false);
        setScan(view);
        setChecked(new Set(view.candidates.filter((c) => c.status === "new").map((c) => c.key)));
      })
      .catch((e) => {
        if (ticket !== scanTicket.current) return;
        const { code, message } = errorOf(e);
        if (code === "needs_keepass_password" || code === "wrong_keepass_password") {
          setNeedsKeepass(true);
          setError(code === "wrong_keepass_password" ? (message ?? null) : null);
        } else if (code === "wrong_passphrase") {
          setUnlocked(null);
          setError(message ?? "That passphrase doesn't unlock this file");
        } else {
          setError(message ?? "The import source couldn't be read");
        }
      })
      .finally(() => {
        if (ticket === scanTicket.current) setBusy(false);
      });
  }, [sourceRequest]);

  const candidates = scan?.candidates ?? [];
  const picked = candidates.filter((c) => checked.has(c.key));
  const newCount = picked.filter((c) => c.status === "new").length;
  const mergeCount = picked.filter((c) => c.status === "existing").length;
  const fileCount = importSql ? picked.reduce((n, c) => n + c.sqlFiles, 0) : 0;
  const totalSql = candidates.reduce((n, c) => n + c.sqlFiles, 0) + (scan?.scratchFiles ?? 0);
  const sourceName = SOURCES.find((s) => s.id === source)?.name ?? "";

  const toggle = (key: string) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chooseSource = (id: SourceId) => {
    if (id === source) return;
    setSource(id);
    setError(null);
    setNeedsKeepass(false);
  };

  const addProject = async () => {
    const dir = await pickFolder({ title: "Add a project folder" });
    if (dir && !projects.includes(dir)) setProjects([...projects, dir]);
  };

  const chooseClew = async () => {
    const path = await pickFile({
      title: "Import a Clew export",
      filters: [{ name: "Clew export", extensions: ["clew", "json"] }],
    });
    if (!path) return;
    setError(null);
    setUnlocked(null);
    setPassphrase("");
    try {
      const info = await importClewInspect(path);
      setClewInfo(info);
      setClewPath(path);
    } catch (e) {
      setClewInfo(null);
      setClewPath(null);
      setError(errorOf(e).message ?? "That isn't a Clew export");
    }
  };

  const chooseDbeaver = async () => {
    const path = await pickFile({
      title: "Choose DBeaver's data-sources.json",
      filters: [{ name: "data-sources", extensions: ["json"] }],
    });
    if (path) setDbeaverPath(path);
  };

  const run = async () => {
    if (!scan) return;
    const options: CommitOptions = {
      environment: env === "detect" ? null : env,
      group:
        groupMode === "keep"
          ? { mode: "keep" }
          : { mode: "single", name: `Imported from ${sourceName}` },
      importSqlFiles: importSql,
    };
    setBusy(true);
    setError(null);
    try {
      const done = await importCommit(
        scan.scanId,
        picked.map((c) => ({ key: c.key, mergeOnly: c.status === "existing" })),
        options,
      );
      setResult(done);
      for (const w of done.warnings) useNotices.getState().push(w);
      // Pick up the new rows in the list.
      await useConnections.getState().load();
    } catch (e) {
      setError(errorOf(e).message ?? "The import failed");
    } finally {
      setBusy(false);
    }
  };

  const importLabel = useMemo(() => {
    if (busy && scan) return "Importing…";
    const total = newCount + mergeCount;
    if (total === 0) return "Import";
    const base = newCount > 0 ? `Import ${plural(newCount, "connection")}` : "Merge SQL files";
    return fileCount > 0 ? `${base} · ${plural(fileCount, "file")}` : base;
  }, [busy, scan, newCount, mergeCount, fileCount]);

  if (result) {
    return (
      <div className={styles.donePane}>
        <p className={styles.success}>
          <Check size={14} /> Imported {plural(result.added, "connection")}
          {result.merged > 0 ? `, merged into ${plural(result.merged, "existing connection")}` : ""}
          {result.sqlFiles > 0 ? ` · ${plural(result.sqlFiles, "SQL file")}` : ""}
        </p>
        {result.warnings.length > 0 ? (
          <ul className={styles.warnings}>
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        <div className={styles.footerActions}>
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const encryptedLocked = source === "clew" && clewInfo?.encrypted && unlocked === null;

  return (
    <>
      <div className={styles.importBody}>
        <div className={styles.stack}>
          <h2 className={styles.h}>Import from</h2>
          <div className={styles.sources}>
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={styles.source}
                aria-pressed={source === s.id}
                onClick={() => chooseSource(s.id)}
              >
                <span className={styles.sourceName}>{s.name}</span>
                <small>{s.sub}</small>
              </button>
            ))}
          </div>
        </div>

        {source === "datagrip" ? (
          <div className={styles.stack}>
            <div className={styles.pickRowLine}>
              <div className={styles.fld}>
                <label htmlFor="dg-src">DataGrip settings found</label>
                <Select
                  id="dg-src"
                  value={dgDir ?? ""}
                  disabled={installs.length === 0}
                  onChange={(e) => setDgDir(e.target.value)}
                >
                  {installs.length === 0 ? (
                    <option value="">No DataGrip settings found</option>
                  ) : null}
                  {installs.map((i) => (
                    <option key={i.path} value={i.path}>
                      {i.label} · {i.path}
                    </option>
                  ))}
                </Select>
              </div>
              <Button variant="default" onClick={() => void addProject()}>
                Add a project folder…
              </Button>
            </div>
            {projects.length > 0 ? (
              <ul className={styles.projectList}>
                {projects.map((p) => (
                  <li key={p}>
                    <span className={styles.mono}>{p}</span>
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => setProjects(projects.filter((x) => x !== p))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {source === "clew" ? (
          <div className={styles.stack}>
            {clewPath && clewInfo ? (
              <div className={styles.fileCard}>
                <File size={16} />
                <span className={styles.mono}>{clewPath.split(/[\\/]/).pop()}</span>
                <span className={styles.muted}>{describeFile(clewInfo)}</span>
                <div className={styles.spacer} />
                <Button variant="default" onClick={() => void chooseClew()}>
                  Choose another…
                </Button>
              </div>
            ) : (
              <div>
                <Button variant="default" onClick={() => void chooseClew()}>
                  Choose a file…
                </Button>
              </div>
            )}
            {encryptedLocked ? (
              <form
                className={styles.unlockBox}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (passphrase) setUnlocked(passphrase);
                }}
              >
                <div className={styles.unlockTitle}>This file is encrypted</div>
                <div className={styles.fld}>
                  <label htmlFor="ip">Passphrase</label>
                  <div className={styles.inline}>
                    <Input
                      id="ip"
                      dialog
                      mono
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      autoComplete="off"
                    />
                    <Button variant="primary" type="submit" disabled={!passphrase || busy}>
                      Unlock
                    </Button>
                  </div>
                </div>
                <p className={styles.unlockNote}>
                  SSH keys are saved to Clew&apos;s key folder, readable only by you. Passwords go
                  to your system keychain.
                </p>
              </form>
            ) : null}
          </div>
        ) : null}

        {source === "dbeaver" || source === "pgpass" ? (
          <div className={styles.stack}>
            <p className={styles.muted}>{OTHER_NOTE[source]}</p>
            {source === "dbeaver" ? (
              <div className={styles.inline}>
                <Button variant="default" onClick={() => void chooseDbeaver()}>
                  {dbeaverPath ? "Choose another…" : "Choose data-sources.json…"}
                </Button>
                {dbeaverPath ? <span className={styles.mono}>{dbeaverPath}</span> : null}
              </div>
            ) : (
              <Checkbox
                label="Import passwords"
                description="Store the passwords from ~/.pgpass in your system keychain."
                checked={pgpassPasswords}
                onChange={(e) => setPgpassPasswords(e.target.checked)}
              />
            )}
          </div>
        ) : null}

        {needsKeepass ? (
          <form
            className={styles.unlockBox}
            onSubmit={(e) => {
              e.preventDefault();
              if (keepassPassword) setKeepassSent({ value: keepassPassword });
            }}
          >
            <div className={styles.unlockTitle}>DataGrip keeps passwords in KeePass</div>
            <div className={styles.fld}>
              <label htmlFor="kp">DataGrip&apos;s master password</label>
              <div className={styles.inline}>
                <Input
                  id="kp"
                  dialog
                  mono
                  type="password"
                  value={keepassPassword}
                  onChange={(e) => setKeepassPassword(e.target.value)}
                  autoComplete="off"
                />
                <Button variant="primary" type="submit" disabled={!keepassPassword || busy}>
                  Unlock
                </Button>
              </div>
            </div>
            <p className={styles.unlockNote}>
              Used once to read the database and then discarded. Clew never stores it.
            </p>
          </form>
        ) : null}

        {error ? (
          <p role="alert" className={styles.problem}>
            {error}
          </p>
        ) : null}

        {scan ? (
          <>
            {scan.warnings.map((w) => (
              <p key={w} className={styles.warn}>
                {w}
              </p>
            ))}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col" className={styles.checkCol}></th>
                    <th scope="col">Data source</th>
                    <th scope="col">Address</th>
                    <th scope="col">SQL files</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => {
                    const st = statusLabel(c);
                    return (
                      <tr key={c.key} data-unavailable={c.status === "unavailable"}>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked.has(c.key)}
                            disabled={c.status === "unavailable"}
                            onChange={() => toggle(c.key)}
                            aria-label={`Import ${c.name}${
                              c.status === "unavailable" ? " (not available)" : ""
                            }`}
                          />
                        </td>
                        <td>
                          <span className={styles.nameCell}>
                            <DriverBadge driver={badgeDriver(c.driver)} />
                            {c.name}
                          </span>
                        </td>
                        <td className={`${styles.mono} ${styles.addr}`}>{c.address}</td>
                        <td>{c.sqlFiles > 0 ? plural(c.sqlFiles, "file") : "—"}</td>
                        <td data-tone={st.tone}>{st.text}</td>
                      </tr>
                    );
                  })}
                  {candidates.length === 0 ? (
                    <tr>
                      <td colSpan={5} className={styles.empty}>
                        Nothing to import was found here.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className={styles.optionGrid}>
              {source !== "pgpass" && source !== "dbeaver" ? (
                <Checkbox
                  label="Import SQL consoles and scratch files"
                  description={
                    totalSql > 0
                      ? `${plural(totalSql, "file")} are copied to ~/Documents/Clew/Scripts/<connection>/ and linked to their connection.`
                      : "No SQL files were found."
                  }
                  checked={importSql}
                  disabled={totalSql === 0}
                  onChange={(e) => setImportSql(e.target.checked)}
                />
              ) : null}
              {source === "datagrip" ? (
                <Checkbox
                  label="Try to import saved passwords"
                  description="From DataGrip's Password Safe: your system keychain (macOS asks once per connection) or its KeePass database (you may be asked for DataGrip's master password)."
                  checked={withPasswords}
                  onChange={(e) => setWithPasswords(e.target.checked)}
                />
              ) : null}
              <div className={styles.fld}>
                <label htmlFor="imp-env">Environment for imported connections</label>
                <Select
                  id="imp-env"
                  value={env}
                  onChange={(e) => setEnv(e.target.value as "detect" | Environment)}
                >
                  <option value="detect">Detect from name (prod → Production)</option>
                  {ENVIRONMENTS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className={styles.fld}>
                <label htmlFor="imp-group">Put them in group</label>
                <Select
                  id="imp-group"
                  value={groupMode}
                  onChange={(e) => setGroupMode(e.target.value as "single" | "keep")}
                >
                  <option value="single">Imported from {sourceName}</option>
                  <option value="keep">Keep {sourceName} folders as groups</option>
                </Select>
              </div>
            </div>
          </>
        ) : null}
        {busy && !scan ? <p className={styles.muted}>Reading…</p> : null}
        <div className={styles.spacer} />
      </div>
      <div className={styles.footer}>
        <span className={styles.footNote}>
          Nothing is saved until you press Import. Duplicates are never overwritten.
        </span>
        <div className={styles.spacer} />
        <Button variant="default" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!scan || busy || newCount + mergeCount === 0}
          onClick={() => void run()}
        >
          {importLabel}
        </Button>
      </div>
    </>
  );
}

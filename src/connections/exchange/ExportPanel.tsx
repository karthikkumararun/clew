import { useEffect, useMemo, useState } from "react";
import { DriverBadge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Checkbox, Input } from "../../components/Input";
import { Check, File } from "../../components/icons";
import { useNotices } from "../../stores/noticesStore";
import { connectionsExport, connectionsExportSummary } from "../api";
import type { Connection, ExportOptions, ExportSummary } from "../api";
import { useConnections } from "../connectionsStore";
import { badgeDriver } from "../display";
import { pickSavePath } from "../files";
import { passphraseProblem, passphraseStrength } from "./passphrase";
import styles from "./ImportExport.module.css";

function usesKey(c: Connection) {
  return Boolean(c.ssh?.enabled && c.ssh.auth === "key");
}

function describe(summary: ExportSummary | null, o: ExportOptions): string {
  if (!summary) return "";
  const n = summary.counts;
  const parts = [`${n.connections} connection${n.connections === 1 ? "" : "s"}`];
  if (o.includePasswords) parts.push(`${n.passwords} password${n.passwords === 1 ? "" : "s"}`);
  if (o.includeSshKeys) parts.push(`${n.sshKeys} SSH key${n.sshKeys === 1 ? "" : "s"}`);
  if (o.includeSqlFiles) parts.push(`${n.sqlFiles} SQL file${n.sqlFiles === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function ExportPanel({ onDone }: { onDone: () => void }) {
  const file = useConnections((s) => s.file);
  const selectedId = useConnections((s) => s.selectedId);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(selectedId ? [selectedId] : file.connections.map((c) => c.id)),
  );
  const [options, setOptions] = useState<ExportOptions>({
    includePasswords: true,
    includeSshKeys: true,
    includeSqlFiles: true,
  });
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ path: string; summary: ExportSummary } | null>(null);

  const ids = useMemo(
    () => file.connections.filter((c) => picked.has(c.id)).map((c) => c.id),
    [file, picked],
  );

  // The summary reads the keychain, key files and scripts folders, so debounce it.
  useEffect(() => {
    if (ids.length === 0) {
      setSummary(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      connectionsExportSummary(ids, options)
        .then((s) => live && setSummary(s))
        .catch(() => live && setSummary(null));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ids, options]);

  const sections = useMemo(() => {
    const groups = [...file.groups].sort(
      (a, b) => a.order - b.order || a.name.localeCompare(b.name),
    );
    const known = new Set(groups.map((g) => g.id));
    return [
      ...groups.map((g) => ({
        name: g.name,
        items: file.connections.filter((c) => c.groupId === g.id),
      })),
      {
        name: "Ungrouped",
        items: file.connections.filter((c) => !c.groupId || !known.has(c.groupId)),
      },
    ].filter((s) => s.items.length > 0);
  }, [file]);

  const needsPassphrase = summary
    ? summary.encrypted
    : options.includePasswords || options.includeSshKeys;
  const problem = needsPassphrase ? passphraseProblem(passphrase, confirm) : null;
  const strength = passphraseStrength(passphrase);
  const fileExt = needsPassphrase ? "clew" : "json";
  const today = new Date().toISOString().slice(0, 10);
  const fileName = `clew-connections-${today}.${fileExt}`;
  const canExport = ids.length > 0 && !problem && !busy;

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    setError(null);
    const path = await pickSavePath({
      title: "Export connections",
      defaultPath: fileName,
      filters: [{ name: needsPassphrase ? "Clew export" : "JSON", extensions: [fileExt] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const result = await connectionsExport(
        ids,
        options,
        needsPassphrase ? passphrase : null,
        path,
      );
      setPassphrase("");
      setConfirm("");
      setDone({ path, summary: result });
      for (const w of result.warnings) useNotices.getState().push(w);
    } catch (e) {
      setError((e as { message?: string }).message ?? "The export failed");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className={styles.donePane}>
        <p className={styles.success}>
          <Check size={14} /> Exported {describe(done.summary, options)}
        </p>
        <p className={`${styles.mono} ${styles.path}`}>{done.path}</p>
        {done.summary.warnings.length > 0 ? (
          <ul className={styles.warnings}>
            {done.summary.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        <p className={styles.muted}>
          {done.summary.encrypted
            ? "Send the passphrase separately — Clew can't recover it."
            : "Whoever imports this file will be asked for passwords when they connect."}
        </p>
        <div className={styles.footerActions}>
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={styles.exportBody}>
        <div className={styles.picker}>
          <div className={styles.pickerHead}>
            <h2 className={styles.h}>Connections to export</h2>
            <button
              type="button"
              className={styles.link}
              onClick={() =>
                setPicked(
                  picked.size === file.connections.length
                    ? new Set()
                    : new Set(file.connections.map((c) => c.id)),
                )
              }
            >
              {picked.size === file.connections.length ? "Select none" : "Select all"}
            </button>
          </div>
          {file.connections.length === 0 ? (
            <p className={styles.muted}>There are no saved connections yet.</p>
          ) : null}
          {sections.map((s) => (
            <div key={s.name}>
              <div className={styles.groupLabel}>{s.name}</div>
              {s.items.map((c) => (
                <label key={c.id} className={styles.pickRow}>
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                  <DriverBadge driver={badgeDriver(c.driver)} />
                  {c.name}
                  {usesKey(c) ? <span className={styles.hintRight}>ssh key</span> : null}
                </label>
              ))}
            </div>
          ))}
        </div>

        <div className={styles.options}>
          <div className={styles.stack}>
            <h2 className={styles.h}>Include</h2>
            <Checkbox
              label="Connection settings, groups and environments"
              description="Always included. Hosts, ports, databases, SSH and TLS settings."
              checked
              disabled
              onChange={() => {}}
            />
            <Checkbox
              label="Saved passwords"
              description="Database passwords and SSH passphrases from your keychain, encrypted inside the file."
              checked={options.includePasswords}
              onChange={(e) => setOptions({ ...options, includePasswords: e.target.checked })}
            />
            <Checkbox
              label="SSH private keys"
              description="The key files these connections use, embedded and encrypted."
              checked={options.includeSshKeys}
              onChange={(e) => setOptions({ ...options, includeSshKeys: e.target.checked })}
            />
            <Checkbox
              label="SQL files linked to these connections"
              description="Files from their Scripts folders."
              checked={options.includeSqlFiles}
              onChange={(e) => setOptions({ ...options, includeSqlFiles: e.target.checked })}
            />
          </div>

          {needsPassphrase ? (
            <div className={styles.passBox}>
              <div className={styles.passTitle}>Protect the file with a passphrase</div>
              <div className={styles.passRow}>
                <div className={styles.fld}>
                  <label htmlFor="pp1">Passphrase</label>
                  <Input
                    id="pp1"
                    dialog
                    mono
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <div className={styles.fld}>
                  <label htmlFor="pp2">Confirm passphrase</label>
                  <Input
                    id="pp2"
                    dialog
                    mono
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
              </div>
              <div className={styles.meterRow}>
                <div className={styles.meter} aria-hidden="true">
                  {[1, 2, 3, 4].map((i) => (
                    <span key={i} data-on={strength.score >= i} />
                  ))}
                </div>
                <span className={styles.strength} data-testid="strength">
                  {passphrase ? strength.label : ""}
                </span>
              </div>
              {passphrase && problem ? (
                <p role="alert" className={styles.problem}>
                  {problem}
                </p>
              ) : null}
              <p className={styles.passNote}>
                Clew can&apos;t recover this passphrase. Send it to the other person separately,
                never in the same message as the file.
              </p>
            </div>
          ) : (
            <p className={styles.plainNote}>
              No secrets included, so the file is plain JSON. Whoever imports it will be asked for
              passwords when they connect.
            </p>
          )}

          {error ? (
            <p role="alert" className={styles.problem}>
              {error}
            </p>
          ) : null}
          <div className={styles.spacer} />
          <div className={styles.fileCard}>
            <File size={16} />
            <span className={styles.mono}>{fileName}</span>
            <span className={styles.muted}>{describe(summary, options)}</span>
          </div>
          {summary?.warnings.map((w) => (
            <p key={w} className={styles.warn}>
              {w}
            </p>
          ))}
        </div>
      </div>
      <div className={styles.footer}>
        <span className={styles.footNote}>
          {needsPassphrase
            ? "Encrypted with AES-256-GCM; key derived from your passphrase with Argon2id."
            : "Plain JSON. No secrets inside."}
        </span>
        <div className={styles.spacer} />
        <Button variant="default" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canExport} onClick={() => void run()}>
          {busy ? "Exporting…" : "Export…"}
        </Button>
      </div>
    </>
  );
}

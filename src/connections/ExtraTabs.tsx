import { Checkbox, Input, Select } from "../components/Input";
import { Button } from "../components/Button";
import type { SshAuthKind } from "../lib/ipc/generated/SshAuthKind";
import type { TlsMode } from "../lib/ipc/generated/TlsMode";
import type { Draft, Errors } from "./draft";
import { levelsBeforeOpen } from "../features/sessions/isolation";
import { Field } from "./Field";
import { pickFolder } from "./files";
import styles from "./ConnectionDialog.module.css";

interface TabProps {
  draft: Draft;
  errors: Errors;
  patch: (p: Partial<Draft>) => void;
}

const AUTH: { value: SshAuthKind; label: string }[] = [
  { value: "agent", label: "SSH agent" },
  { value: "key", label: "Key file" },
  { value: "password", label: "Password" },
];

export function SshTab({ draft, errors, patch }: TabProps) {
  const off = !draft.sshEnabled;
  return (
    <div className={styles.stack}>
      <Checkbox
        label="Connect through an SSH tunnel"
        description="Clew opens a local forward and connects through it."
        checked={draft.sshEnabled}
        onChange={(e) => patch({ sshEnabled: e.target.checked })}
      />
      <div className={styles.hostPort}>
        <Field label="SSH host" error={errors.sshHost}>
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              disabled={off}
              value={draft.sshHost}
              onChange={(e) => patch({ sshHost: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <Field label="SSH port" error={errors.sshPort}>
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              disabled={off}
              inputMode="numeric"
              value={draft.sshPort}
              onChange={(e) => patch({ sshPort: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className={styles.row180}>
        <Field label="SSH user">
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              disabled={off}
              value={draft.sshUser}
              onChange={(e) => patch({ sshUser: e.target.value })}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Authentication">
          {(p) => (
            <Select
              {...p}
              disabled={off}
              value={draft.sshAuth}
              onChange={(e) => patch({ sshAuth: e.target.value as SshAuthKind })}
            >
              {AUTH.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {draft.sshAuth === "key" ? (
        <div className={styles.row180}>
          <Field label="Key file">
            {(p) => (
              <Input
                {...p}
                dialog
                mono
                disabled={off}
                placeholder="~/.ssh/id_ed25519"
                value={draft.sshKeyFile}
                onChange={(e) => patch({ sshKeyFile: e.target.value })}
              />
            )}
          </Field>
          <Field label="Key passphrase">
            {(p) => (
              <Input
                {...p}
                dialog
                mono
                type="password"
                disabled={off}
                placeholder="optional"
                value={draft.sshPassphrase}
                onChange={(e) => patch({ sshPassphrase: e.target.value })}
                autoComplete="new-password"
              />
            )}
          </Field>
        </div>
      ) : null}
      {draft.sshAuth === "password" ? (
        <Field label="SSH password">
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              type="password"
              disabled={off}
              value={draft.sshPassword}
              onChange={(e) => patch({ sshPassword: e.target.value })}
              autoComplete="new-password"
            />
          )}
        </Field>
      ) : null}
      <p className={styles.hint}>
        Hosts from <span className="mono">~/.ssh/config</span> are used when the name matches.
      </p>
    </div>
  );
}

const TLS_MODES: TlsMode[] = ["verify-full", "verify-ca", "require", "prefer", "disable"];

export function TlsTab({ draft, patch }: TabProps) {
  const off = draft.tlsMode === "disable";
  return (
    <div className={styles.stack}>
      <Field label="SSL mode">
        {(p) => (
          <Select
            {...p}
            value={draft.tlsMode}
            onChange={(e) => patch({ tlsMode: e.target.value as TlsMode })}
          >
            {TLS_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="CA certificate">
        {(p) => (
          <Input
            {...p}
            dialog
            mono
            disabled={off}
            placeholder="optional — the system trust store is used when empty"
            value={draft.caFile}
            onChange={(e) => patch({ caFile: e.target.value })}
          />
        )}
      </Field>
      <div className={styles.row180}>
        <Field label="Client certificate">
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              disabled={off}
              placeholder="optional"
              value={draft.clientCert}
              onChange={(e) => patch({ clientCert: e.target.value })}
            />
          )}
        </Field>
        <Field label="Client key">
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              disabled={off}
              placeholder="optional"
              value={draft.clientKey}
              onChange={(e) => patch({ clientKey: e.target.value })}
            />
          )}
        </Field>
      </div>
    </div>
  );
}

export function AdvancedTab({ draft, patch }: TabProps) {
  const setProp = (i: number, change: Partial<{ key: string; value: string }>) =>
    patch({ properties: draft.properties.map((p, j) => (j === i ? { ...p, ...change } : p)) });
  return (
    <div className={styles.stack}>
      <div className={styles.row160}>
        <Field label="Connect timeout (s)">
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              inputMode="numeric"
              value={draft.connectTimeout}
              onChange={(e) => patch({ connectTimeout: e.target.value })}
            />
          )}
        </Field>
        <Field label="Query timeout (s, 0 = none)">
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              inputMode="numeric"
              value={draft.queryTimeout}
              onChange={(e) => patch({ queryTimeout: e.target.value })}
            />
          )}
        </Field>
        <Field label="Keep-alive (s, 0 = off)">
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              inputMode="numeric"
              value={draft.keepAlive}
              onChange={(e) => patch({ keepAlive: e.target.value })}
            />
          )}
        </Field>
      </div>
      {levelsBeforeOpen(draft.driver).length > 0 ? (
        <Field label="Default isolation level">
          {(p) => (
            <Select
              {...p}
              value={draft.isolation}
              onChange={(e) => patch({ isolation: e.target.value })}
            >
              <option value="">Server default</option>
              {levelsBeforeOpen(draft.driver).map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      <Field label="Run on connect">
        {(p) => (
          <textarea
            {...p}
            className={`${styles.textarea} mono`}
            rows={3}
            placeholder="One statement per line"
            value={draft.onConnect}
            onChange={(e) => patch({ onConnect: e.target.value })}
            spellCheck={false}
          />
        )}
      </Field>
      <div className={styles.fld}>
        <span className={styles.lbl}>Driver properties</span>
        <div className={`${styles.props} mono`}>
          {draft.properties.map((prop, i) => (
            <div key={i} className={styles.prop}>
              <input
                className={styles.propInput}
                aria-label={`Property ${i + 1} name`}
                value={prop.key}
                onChange={(e) => setProp(i, { key: e.target.value })}
              />
              <input
                className={styles.propInput}
                aria-label={`Property ${i + 1} value`}
                value={prop.value}
                onChange={(e) => setProp(i, { value: e.target.value })}
              />
              <Button
                variant="ghost"
                aria-label={`Remove property ${i + 1}`}
                onClick={() => patch({ properties: draft.properties.filter((_, j) => j !== i) })}
              >
                ×
              </Button>
            </div>
          ))}
          <div className={styles.prop}>
            <Button
              variant="ghost"
              onClick={() => patch({ properties: [...draft.properties, { key: "", value: "" }] })}
            >
              + add property
            </Button>
          </div>
        </div>
      </div>
      <Field label="SQL scripts folder">
        {(p) => (
          <div style={{ display: "flex", gap: 8 }}>
            <Input
              {...p}
              dialog
              mono
              placeholder={`~/Documents/Clew/Scripts/${draft.name.trim() || "<connection name>"}/`}
              value={draft.scriptsDir}
              onChange={(e) => patch({ scriptsDir: e.target.value })}
            />
            <Button
              variant="default"
              onClick={() =>
                void pickFolder({ title: "Scripts folder" }).then(
                  (dir) => dir && patch({ scriptsDir: dir }),
                )
              }
            >
              Browse…
            </Button>
          </div>
        )}
      </Field>
    </div>
  );
}

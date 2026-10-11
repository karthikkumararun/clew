import { Checkbox, Input, Select } from "../components/Input";
import { Button } from "../components/Button";
import { catalogDriver } from "./catalog";
import type { ConnectBy, Draft, Errors } from "./draft";
import { Field } from "./Field";
import type { PasswordMode } from "../lib/ipc/generated/PasswordMode";
import styles from "./ConnectionDialog.module.css";
import { INSTANT_CLIENT_URL } from "./oracleClient";
import type { OracleClient } from "./oracleClient";

export interface FormProps {
  draft: Draft;
  errors: Errors;
  patch: (p: Partial<Draft>) => void;
  /** Edit the port by hand: stops it following the driver default. */
  setPort: (port: string) => void;
  pickFile: () => void;
  /** Whether a password is already saved for this connection. */
  passwordSaved: boolean;
  /** The Oracle Instant Client, for the Oracle form. */
  oracleClient?: OracleClient;
}

const SAVE_MODES: { value: PasswordMode; label: string }[] = [
  { value: "keychain", label: "In system keychain" },
  { value: "ask", label: "Ask every time" },
  { value: "none", label: "Don’t save" },
];

function HostPort({ draft, errors, patch, setPort }: FormProps) {
  return (
    <div className={styles.hostPort}>
      <Field label="Host" error={errors.host}>
        {(p) => (
          <Input
            {...p}
            dialog
            mono
            value={draft.host}
            onChange={(e) => patch({ host: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <Field label="Port" error={errors.port}>
        {(p) => (
          <Input
            {...p}
            dialog
            mono
            inputMode="numeric"
            value={draft.port}
            onChange={(e) => setPort(e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

function Credentials({ draft, patch, passwordSaved }: FormProps) {
  const keychain = draft.passwordMode === "keychain";
  return (
    <>
      <Field label="User">
        {(p) => (
          <Input
            {...p}
            dialog
            mono
            value={draft.user}
            onChange={(e) => patch({ user: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <Field label="Password">
        {(p) => (
          <Input
            {...p}
            dialog
            mono
            type="password"
            disabled={!keychain}
            placeholder={keychain && passwordSaved ? "Saved — type to replace" : undefined}
            value={draft.password}
            onChange={(e) => patch({ password: e.target.value, clearPassword: false })}
            autoComplete="new-password"
          />
        )}
      </Field>
      <Field label="Save password">
        {(p) => (
          <Select
            {...p}
            value={draft.passwordMode}
            onChange={(e) => patch({ passwordMode: e.target.value as PasswordMode })}
          >
            {SAVE_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}

export function NetworkForm(props: FormProps) {
  const { draft, patch } = props;
  return (
    <div className={styles.stack}>
      <HostPort {...props} />
      <div className={styles.row180}>
        <Credentials {...props} />
      </div>
      <Field label="Database">
        {(p) => (
          <Input
            {...p}
            dialog
            mono
            value={draft.database}
            onChange={(e) => patch({ database: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
    </div>
  );
}

const CONNECT_BY: { value: ConnectBy; label: string; field: string }[] = [
  { value: "serviceName", label: "Service name", field: "Service name" },
  { value: "sid", label: "SID", field: "SID" },
  { value: "tnsAlias", label: "TNS alias", field: "TNS alias" },
  { value: "easyConnect", label: "Easy Connect string", field: "Easy Connect string" },
];

/** What the Oracle form says about the Instant Client, and how to fix it when it is missing. */
export function InstantClientStatus({ client }: { client?: OracleClient }) {
  const status = client?.status ?? null;
  if (status && !status.found) {
    return (
      <div
        className={styles.note}
        data-testid="instant-client-status"
        data-state="missing"
        role="alert"
      >
        <span className={styles.noteDot} data-bad />
        <span style={{ flex: 1 }}>
          <strong>Oracle needs the free Oracle Instant Client.</strong> Download “Basic” or “Basic
          Light” for your system from <span className="mono">{INSTANT_CLIENT_URL}</span>, then:
          <br />
          macOS — unzip it, use the ARM64 build on Apple Silicon.
          <br />
          Windows — unzip to <span className="mono">C:\oracle\instantclient_*</span>.
          <br />
          Linux — unzip to <span className="mono">/opt/oracle/instantclient_*</span>.
          <br />
          Clew finds it in the usual places; otherwise choose its folder.
        </span>
        <Button variant="default" onClick={() => void client?.choose()}>
          Choose folder…
        </Button>
      </div>
    );
  }
  return (
    <div
      className={styles.note}
      data-testid="instant-client-status"
      data-state={status ? "found" : "unknown"}
    >
      <span className={styles.noteDot} />
      <span style={{ flex: 1 }}>
        {status ? (
          <>
            Oracle Instant Client{status.version ? ` ${status.version}` : ""} found in{" "}
            <span className="mono">{status.dir}</span>
          </>
        ) : (
          "Oracle Instant Client is checked when you connect"
        )}
      </span>
      {status ? (
        <Button variant="default" onClick={() => void client?.choose()}>
          Choose folder…
        </Button>
      ) : null}
    </div>
  );
}

export function OracleForm(props: FormProps) {
  const { draft, errors, patch } = props;
  const by = CONNECT_BY.find((c) => c.value === draft.connectBy) ?? CONNECT_BY[0];
  return (
    <div className={styles.stack}>
      <HostPort {...props} />
      <div className={styles.hostPort} style={{ gridTemplateColumns: "170px minmax(0, 1fr)" }}>
        <Field label="Connect by">
          {(p) => (
            <Select
              {...p}
              value={draft.connectBy}
              onChange={(e) => patch({ connectBy: e.target.value as ConnectBy })}
            >
              {CONNECT_BY.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={by.field} error={errors.connectValue}>
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              value={draft.connectValue}
              onChange={(e) => patch({ connectValue: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
      </div>
      <div className={styles.row160}>
        <Credentials {...props} />
        <Field label="Role">
          {(p) => (
            <Select {...p} value={draft.role} onChange={(e) => patch({ role: e.target.value })}>
              <option value="">Default</option>
              <option value="SYSDBA">SYSDBA</option>
              <option value="SYSOPER">SYSOPER</option>
            </Select>
          )}
        </Field>
      </div>
      <Field label="Wallet folder (Autonomous Database, optional)">
        {(p) => (
          <Input
            {...p}
            dialog
            mono
            placeholder="~/wallets/Wallet_mydb"
            value={draft.walletDir}
            onChange={(e) => patch({ walletDir: e.target.value })}
          />
        )}
      </Field>
      <InstantClientStatus client={props.oracleClient} />
    </div>
  );
}

export function FileForm({ draft, errors, patch, pickFile }: FormProps) {
  const label = catalogDriver(draft.driver).name;
  return (
    <div className={styles.stack}>
      <Field label="Database file" error={errors.filePath}>
        {(p) => (
          <div className={styles.fileRow}>
            <Input
              {...p}
              dialog
              mono
              placeholder={`~/data/example.${draft.driver === "duckdb" ? "duckdb" : "sqlite"}`}
              value={draft.filePath}
              onChange={(e) => patch({ filePath: e.target.value })}
              aria-label={`${label} database file`}
            />
            <Button variant="default" onClick={pickFile}>
              Choose…
            </Button>
          </div>
        )}
      </Field>
      <Checkbox
        label="Create the file if it doesn’t exist"
        checked={draft.createIfMissing}
        onChange={(e) => patch({ createIfMissing: e.target.checked })}
      />
    </div>
  );
}

export function UriForm(props: FormProps) {
  const { draft, errors, patch } = props;
  return (
    <div className={styles.stack}>
      <Field label="Connection string" error={errors.uri}>
        {(p) => (
          <Input
            {...p}
            dialog
            mono
            placeholder="mongodb+srv://user@cluster0.example.net/db"
            value={draft.uri}
            onChange={(e) => patch({ uri: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <div className={styles.row180}>
        <Credentials {...props} />
      </div>
      <p className={styles.hint}>
        Put credentials in the User and Password fields rather than in the string.
      </p>
    </div>
  );
}

export function KeyValueForm(props: FormProps) {
  const { draft, patch } = props;
  return (
    <div className={styles.stack}>
      <div
        className={styles.hostPort}
        style={{ gridTemplateColumns: "minmax(0, 1fr) 110px 110px" }}
      >
        <Field label="Host" error={props.errors.host}>
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              value={draft.host}
              onChange={(e) => patch({ host: e.target.value })}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Port" error={props.errors.port}>
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              inputMode="numeric"
              value={draft.port}
              onChange={(e) => props.setPort(e.target.value)}
            />
          )}
        </Field>
        <Field label="DB index">
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              inputMode="numeric"
              value={draft.dbIndex}
              onChange={(e) => patch({ dbIndex: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className={styles.row180}>
        <Credentials {...props} />
      </div>
    </div>
  );
}

const PROTOCOLS = ["neo4j", "neo4j+s", "bolt", "bolt+s"];

export function Neo4jForm(props: FormProps) {
  const { draft, patch } = props;
  return (
    <div className={styles.stack}>
      <div
        className={styles.hostPort}
        style={{ gridTemplateColumns: "150px minmax(0, 1fr) 110px" }}
      >
        <Field label="Protocol">
          {(p) => (
            <Select
              {...p}
              value={draft.protocol}
              onChange={(e) => patch({ protocol: e.target.value })}
            >
              {PROTOCOLS.map((s) => (
                <option key={s} value={s}>
                  {s}://
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Host" error={props.errors.host}>
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              value={draft.host}
              onChange={(e) => patch({ host: e.target.value })}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Port" error={props.errors.port}>
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              inputMode="numeric"
              value={draft.port}
              onChange={(e) => props.setPort(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className={styles.row160}>
        <Credentials {...props} />
        <Field label="Database">
          {(p) => (
            <Input
              {...p}
              dialog
              mono
              value={draft.database}
              onChange={(e) => patch({ database: e.target.value })}
            />
          )}
        </Field>
      </div>
      <p className={styles.hint}>
        Use <span className="mono">neo4j+s://</span> for AuraDB.{" "}
        <span className="mono">neo4j://</span> routes reads and writes across a cluster;{" "}
        <span className="mono">bolt://</span> talks to a single server.
      </p>
    </div>
  );
}

export function GeneralForm(props: FormProps) {
  switch (catalogDriver(props.draft.driver).kind) {
    case "network":
      return <NetworkForm {...props} />;
    case "oracle":
      return <OracleForm {...props} />;
    case "file":
      return <FileForm {...props} />;
    case "uri":
      return <UriForm {...props} />;
    case "keyvalue":
      return <KeyValueForm {...props} />;
    case "neo4j":
      return <Neo4jForm {...props} />;
  }
}

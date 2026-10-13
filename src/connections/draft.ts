/**
 * The connection dialog's editable state and the pure functions around it. Kept free of React
 * so the rules (port follows the driver, name suggestion, validation, URL preview) are testable.
 */
import type { Connection } from "../lib/ipc/generated/Connection";
import type { Environment } from "../lib/ipc/generated/Environment";
import type { OracleConnectBy } from "../lib/ipc/generated/OracleConnectBy";
import type { PasswordMode } from "../lib/ipc/generated/PasswordMode";
import type { Safeguards } from "../lib/ipc/generated/Safeguards";
import type { SaveRequest } from "../lib/ipc/generated/SaveRequest";
import type { SecretUpdate } from "../lib/ipc/generated/SecretUpdate";
import type { Settings } from "../lib/ipc/generated/Settings";
import type { SshAuthKind } from "../lib/ipc/generated/SshAuthKind";
import type { TlsMode } from "../lib/ipc/generated/TlsMode";
import { catalogDriver } from "./catalog";

export type ConnectBy = OracleConnectBy["type"];

export interface Draft {
  /** Empty for a new connection; Rust assigns the id on save. */
  id: string;
  driver: string;
  name: string;
  nameEdited: boolean;
  groupId: string | null;
  environment: Environment;
  safeguards: Safeguards;

  host: string;
  port: string;
  portEdited: boolean;
  user: string;
  database: string;
  passwordMode: PasswordMode;
  /** Typed in this dialog. Empty means "leave the stored one alone". */
  password: string;
  clearPassword: boolean;

  connectBy: ConnectBy;
  connectValue: string;
  role: string;
  walletDir: string;

  filePath: string;
  createIfMissing: boolean;

  uri: string;

  protocol: string;
  dbIndex: string;

  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: SshAuthKind;
  sshKeyFile: string;
  sshPassphrase: string;
  sshPassword: string;

  tlsMode: TlsMode;
  caFile: string;
  clientCert: string;
  clientKey: string;

  connectTimeout: string;
  queryTimeout: string;
  keepAlive: string;
  /** Default transaction isolation level of new sessions; empty = the server's default. */
  isolation: string;
  onConnect: string;
  properties: { key: string; value: string }[];

  scriptsDir: string;
}

export const ENVIRONMENTS: { id: Environment; label: string; short: string }[] = [
  { id: "local", label: "Local", short: "local" },
  { id: "development", label: "Development", short: "dev" },
  { id: "staging", label: "Staging", short: "staging" },
  { id: "production", label: "Production", short: "prod" },
];

export function defaultSafeguards(env: Environment): Safeguards {
  const on = env === "production";
  return { readOnlyByDefault: on, confirmWrites: on, manualCommit: on };
}

export function suggestName(driver: string, env: Environment): string {
  const short = ENVIRONMENTS.find((e) => e.id === env)?.short ?? env;
  return `${short}-${driver}`;
}

function defaultHost(driver: string): string {
  return catalogDriver(driver).kind === "file" ? "" : "localhost";
}

export function newDraft(driver = "postgres", environment: Environment = "local"): Draft {
  const cat = catalogDriver(driver);
  return {
    id: "",
    driver: cat.id,
    name: suggestName(cat.id, environment),
    nameEdited: false,
    groupId: null,
    environment,
    safeguards: defaultSafeguards(environment),
    host: defaultHost(cat.id),
    port: cat.port ? String(cat.port) : "",
    portEdited: false,
    user: "",
    database: "",
    passwordMode: "keychain",
    password: "",
    clearPassword: false,
    connectBy: "serviceName",
    connectValue: "",
    role: "",
    walletDir: "",
    filePath: "",
    createIfMissing: false,
    uri: "",
    protocol: "neo4j",
    dbIndex: "0",
    sshEnabled: false,
    sshHost: "",
    sshPort: "22",
    sshUser: "",
    sshAuth: "agent",
    sshKeyFile: "",
    sshPassphrase: "",
    sshPassword: "",
    tlsMode: "disable",
    caFile: "",
    clientCert: "",
    clientKey: "",
    connectTimeout: "10",
    queryTimeout: "0",
    keepAlive: "0",
    isolation: "",
    onConnect: "",
    properties: [],
    scriptsDir: "",
  };
}

/** Select another driver: the port follows the default until edited, the name suggestion follows. */
export function switchDriver(draft: Draft, driver: string): Draft {
  const cat = catalogDriver(driver);
  const next: Draft = { ...draft, driver: cat.id };
  if (!draft.portEdited) next.port = cat.port ? String(cat.port) : "";
  if (!next.host && cat.kind !== "file") next.host = defaultHost(cat.id);
  if (!draft.nameEdited) next.name = suggestName(cat.id, draft.environment);
  return next;
}

/** Select another environment: safeguards reset to its defaults and the name suggestion follows. */
export function setEnvironment(draft: Draft, environment: Environment): Draft {
  return {
    ...draft,
    environment,
    safeguards: defaultSafeguards(environment),
    name: draft.nameEdited ? draft.name : suggestName(draft.driver, environment),
  };
}

function opt(s: string): string | undefined {
  const t = s.trim();
  return t === "" ? undefined : t;
}

function connectByOf(draft: Draft): OracleConnectBy {
  return { type: draft.connectBy, value: draft.connectValue.trim() };
}

export function settingsOf(draft: Draft): Settings {
  const cat = catalogDriver(draft.driver);
  const port = Number(draft.port) || 0;
  const passwordMode = draft.passwordMode;
  switch (cat.kind) {
    case "network":
      return {
        kind: "network",
        host: draft.host.trim(),
        port,
        database: opt(draft.database),
        user: opt(draft.user),
        passwordMode,
      };
    case "oracle":
      return {
        kind: "oracle",
        host: draft.host.trim(),
        port,
        connectBy: connectByOf(draft),
        user: opt(draft.user),
        role: opt(draft.role),
        walletDir: opt(draft.walletDir),
        passwordMode,
      };
    case "file":
      return { kind: "file", path: draft.filePath.trim(), createIfMissing: draft.createIfMissing };
    case "uri":
      return { kind: "uri", uri: draft.uri.trim(), user: opt(draft.user), passwordMode };
    case "keyvalue":
      return {
        kind: "keyvalue",
        host: draft.host.trim(),
        port,
        dbIndex: Math.max(0, Math.trunc(Number(draft.dbIndex) || 0)),
        user: opt(draft.user),
        passwordMode,
      };
    case "neo4j":
      return {
        kind: "neo4j",
        protocol: draft.protocol,
        host: draft.host.trim(),
        port,
        user: opt(draft.user),
        database: opt(draft.database),
        passwordMode,
      };
  }
}

export function toConnection(draft: Draft): Connection {
  const ssh = draft.sshEnabled
    ? {
        enabled: true,
        host: draft.sshHost.trim(),
        port: Number(draft.sshPort) || 22,
        user: draft.sshUser.trim(),
        auth: draft.sshAuth,
        keyFile: opt(draft.sshKeyFile),
      }
    : undefined;
  const properties: Record<string, string> = {};
  for (const p of draft.properties) if (p.key.trim()) properties[p.key.trim()] = p.value;
  return {
    id: draft.id,
    name: draft.name.trim(),
    driver: draft.driver,
    groupId: draft.groupId ?? undefined,
    environment: draft.environment,
    settings: settingsOf(draft),
    ssh,
    tls: {
      mode: draft.tlsMode,
      caFile: opt(draft.caFile),
      clientCert: opt(draft.clientCert),
      clientKey: opt(draft.clientKey),
    },
    advanced: {
      connectTimeoutSec: Math.max(1, Number(draft.connectTimeout) || 10),
      queryTimeoutSec: Math.max(0, Number(draft.queryTimeout) || 0),
      keepAliveSec: Math.max(0, Number(draft.keepAlive) || 0),
      ...(draft.isolation ? { isolation: draft.isolation } : {}),
      onConnect: draft.onConnect
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      properties,
    },
    safeguards: draft.safeguards,
    scriptsDir: opt(draft.scriptsDir),
  };
}

function secretUpdate(value: string, clear: boolean): SecretUpdate {
  if (value !== "") return { action: "set", value };
  return clear ? { action: "clear" } : { action: "keep" };
}

export function toSaveRequest(draft: Draft): SaveRequest {
  return {
    connection: toConnection(draft),
    password: secretUpdate(draft.password, draft.clearPassword),
    sshPassphrase: secretUpdate(draft.sshPassphrase, false),
    sshPassword: secretUpdate(draft.sshPassword, false),
  };
}

export function draftFromConnection(c: Connection): Draft {
  const base = newDraft(c.driver, c.environment);
  const draft: Draft = {
    ...base,
    id: c.id,
    name: c.name,
    nameEdited: true,
    groupId: c.groupId ?? null,
    safeguards: c.safeguards,
    portEdited: true,
    tlsMode: c.tls.mode,
    caFile: c.tls.caFile ?? "",
    clientCert: c.tls.clientCert ?? "",
    clientKey: c.tls.clientKey ?? "",
    connectTimeout: String(c.advanced.connectTimeoutSec),
    queryTimeout: String(c.advanced.queryTimeoutSec),
    keepAlive: String(c.advanced.keepAliveSec),
    isolation: (c.advanced as { isolation?: string | null }).isolation ?? "",
    onConnect: c.advanced.onConnect.join("\n"),
    properties: Object.entries(c.advanced.properties).map(([key, value]) => ({ key, value })),
    scriptsDir: c.scriptsDir ?? "",
  };
  if (c.ssh) {
    draft.sshEnabled = c.ssh.enabled;
    draft.sshHost = c.ssh.host;
    draft.sshPort = String(c.ssh.port);
    draft.sshUser = c.ssh.user;
    draft.sshAuth = c.ssh.auth;
    draft.sshKeyFile = c.ssh.keyFile ?? "";
  }
  return applySettings(draft, c.settings);
}

/** Copy driver settings (from a saved connection or a parsed URL) into a draft. */
export function applySettings(draft: Draft, s: Settings): Draft {
  const next = { ...draft };
  switch (s.kind) {
    case "network":
      next.host = s.host;
      next.port = String(s.port);
      next.database = s.database ?? "";
      next.user = s.user ?? "";
      next.passwordMode = s.passwordMode;
      break;
    case "oracle":
      next.host = s.host;
      next.port = String(s.port);
      next.connectBy = s.connectBy.type;
      next.connectValue = s.connectBy.value;
      next.user = s.user ?? "";
      next.role = s.role ?? "";
      next.walletDir = s.walletDir ?? "";
      next.passwordMode = s.passwordMode;
      break;
    case "file":
      next.filePath = s.path;
      next.createIfMissing = s.createIfMissing;
      break;
    case "uri":
      next.uri = s.uri;
      next.user = s.user ?? "";
      next.passwordMode = s.passwordMode;
      break;
    case "keyvalue":
      next.host = s.host;
      next.port = String(s.port);
      next.dbIndex = String(s.dbIndex);
      next.user = s.user ?? "";
      next.passwordMode = s.passwordMode;
      break;
    case "neo4j":
      next.protocol = s.protocol;
      next.host = s.host;
      next.port = String(s.port);
      next.user = s.user ?? "";
      next.database = s.database ?? "";
      next.passwordMode = s.passwordMode;
      break;
  }
  return next;
}

export type Errors = Partial<
  Record<
    "name" | "host" | "port" | "filePath" | "uri" | "sshHost" | "sshPort" | "connectValue",
    string
  >
>;

function validPort(s: string): boolean {
  if (!/^\d+$/.test(s.trim())) return false;
  const n = Number(s);
  return n >= 1 && n <= 65535;
}

export function validate(draft: Draft): Errors {
  const errors: Errors = {};
  const kind = catalogDriver(draft.driver).kind;
  if (!draft.name.trim()) errors.name = "Enter a name";
  if (kind === "file") {
    if (!draft.filePath.trim()) errors.filePath = "Choose a database file";
  } else if (kind === "uri") {
    if (!draft.uri.trim()) errors.uri = "Enter a connection string";
  } else {
    if (!draft.host.trim()) errors.host = "Enter a host";
    if (!validPort(draft.port)) errors.port = "Port must be 1–65535";
    if (kind === "oracle" && !draft.connectValue.trim()) {
      errors.connectValue = "Enter the Oracle connection target";
    }
  }
  if (draft.sshEnabled) {
    if (!draft.sshHost.trim()) errors.sshHost = "Enter the SSH host";
    if (!validPort(draft.sshPort)) errors.sshPort = "Port must be 1–65535";
  }
  return errors;
}

/** Which tab holds the first error, so Save can jump to it. */
export function tabOfError(errors: Errors): "general" | "ssh" | null {
  if (
    errors.name ||
    errors.host ||
    errors.port ||
    errors.filePath ||
    errors.uri ||
    errors.connectValue
  )
    return "general";
  if (errors.sshHost || errors.sshPort) return "ssh";
  return null;
}

// ---- URL preview (mirrors src-tauri/src/connections/url.rs `build_url`; never includes a password)

const KEEP = /[A-Za-z0-9\-_.~]/;

function enc(s: string): string {
  let out = "";
  for (const ch of s) {
    if (KEEP.test(ch)) out += ch;
    else
      for (const b of new TextEncoder().encode(ch))
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function bracket(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function userinfo(user: string): string {
  return user.trim() ? `${enc(user.trim())}@` : "";
}

function tlsQuery(driver: string, mode: TlsMode): string[] {
  if (mode === "disable") return [];
  switch (driver) {
    case "postgres":
      return [
        `sslmode=${mode === "prefer" ? "prefer" : mode === "require" ? "require" : mode === "verify-ca" ? "verify-ca" : "verify-full"}`,
      ];
    case "mysql":
    case "mariadb":
      return [
        `ssl-mode=${mode === "prefer" ? "PREFERRED" : mode === "require" ? "REQUIRED" : mode === "verify-ca" ? "VERIFY_CA" : "VERIFY_IDENTITY"}`,
      ];
    case "sqlserver":
      return ["encrypt=true"];
    case "clickhouse":
      return ["secure=true"];
    default:
      return [];
  }
}

function withQuery(base: string, pairs: string[]): string {
  return pairs.length ? `${base}?${pairs.join("&")}` : base;
}

/** The read-only URL shown under the General tab, or `null` when the settings can't form one. */
export function buildUrl(draft: Draft): string | null {
  const cat = catalogDriver(draft.driver);
  const host = bracket(draft.host.trim());
  const port = draft.port.trim();
  const at = host ? `${userinfo(draft.user)}${host}${port ? `:${port}` : ""}` : "";
  switch (cat.kind) {
    case "network": {
      if (!host) return null;
      const db = draft.database.trim() ? `/${enc(draft.database.trim())}` : "";
      return withQuery(`${cat.scheme}://${at}${db}`, tlsQuery(draft.driver, draft.tlsMode));
    }
    case "oracle": {
      if (!host) return null;
      const v = draft.connectValue.trim();
      if (draft.connectBy === "serviceName") return `oracle://${at}${v ? `/${enc(v)}` : ""}`;
      if (draft.connectBy === "sid") return withQuery(`oracle://${at}`, v ? [`sid=${enc(v)}`] : []);
      return null;
    }
    case "file":
      return draft.filePath.trim() ? `${cat.scheme}:${draft.filePath.trim()}` : null;
    case "uri": {
      const uri = draft.uri.trim();
      if (!uri) return null;
      const m = /^([a-z+]+:\/\/)(?:[^@/]*@)?(.*)$/i.exec(uri);
      if (!m) return uri;
      return `${m[1]}${userinfo(draft.user)}${m[2]}`;
    }
    case "keyvalue": {
      if (!host) return null;
      const scheme = draft.tlsMode === "disable" ? "redis" : "rediss";
      const idx = Number(draft.dbIndex) > 0 ? `/${Number(draft.dbIndex)}` : "";
      return `${scheme}://${at}${idx}`;
    }
    case "neo4j": {
      if (!host) return null;
      const db = draft.database.trim() ? `/${enc(draft.database.trim())}` : "";
      return `${draft.protocol}://${at}${db}`;
    }
  }
}

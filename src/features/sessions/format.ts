import type { SessionMeta, SessionState } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

/** `00:12` — a running statement. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** `4:12` — how long a transaction has been open. */
export function openFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** `10:06:20` in local time. */
export function timeOfDay(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `4 min 12 s` */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${pad(s % 60)} s`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const STATE_LABEL: Record<SessionState, string> = {
  idle: "Idle",
  running: "Running",
  in_transaction: "In transaction",
  aborted: "Failed transaction",
  disconnected: "Disconnected",
};

/** Token colour of a state; an open transaction turns red on production. */
export function stateColor(state: SessionState, production: boolean): string {
  switch (state) {
    case "idle":
      return "var(--success)";
    case "running":
      return "var(--info)";
    case "in_transaction":
      return production ? "var(--danger)" : "var(--warning)";
    case "aborted":
      return "var(--danger)";
    case "disconnected":
      return "var(--text-dim)";
  }
}

/** The state with its live detail: `Running 00:12`, `In transaction 4:12`. */
export function stateText(s: SessionMeta, now: number): string {
  switch (s.state) {
    case "running":
      return `Running ${clock(now - (s.runningSince ?? s.lastActivityAt))}`;
    case "in_transaction":
      return `In transaction ${openFor(now - (s.txStartedAt ?? s.lastActivityAt))}`;
    default:
      return STATE_LABEL[s.state];
  }
}

/** The right-hand cell of a row: the start of a running statement, else the statement count. */
export function rowDetail(s: SessionMeta): string {
  if (s.state === "running" && s.runningStatement) {
    const flat = s.runningStatement.replace(/\s+/g, " ").trim();
    const head = flat.split(" ")[0]?.toUpperCase() ?? "";
    return flat.length > head.length ? `${head} …` : head;
  }
  return plural(s.txStatementCount, "statement");
}

/** `4 sessions · 1 in transaction` */
export function connectionSummary(sessions: SessionMeta[], disconnected: boolean): string {
  if (disconnected) return "disconnected";
  const tx = sessions.filter((s) => s.state === "in_transaction" || s.state === "aborted").length;
  const base = plural(sessions.length, "session");
  return tx > 0 ? `${base} · ${tx} in transaction` : base;
}

/** `3 UPDATE, 1 INSERT, 1 DELETE, 2 SELECT` — kinds that ran, most frequent first. */
export function breakdownText(b: SessionMeta["txBreakdown"]): string {
  return (Object.entries(b) as [string, number][])
    .filter(([, n]) => n > 0)
    .sort((x, y) => y[1] - x[1])
    .map(([k, n]) => `${n} ${k.toUpperCase()}`)
    .join(", ");
}

/** What Roll back / Commit / Cancel are allowed to do for a session. */
export function actionsOf(s: SessionMeta | undefined) {
  return {
    cancel: s?.state === "running",
    commit: s?.state === "in_transaction",
    rollback: s?.state === "in_transaction" || s?.state === "aborted",
    close: s !== undefined,
  };
}

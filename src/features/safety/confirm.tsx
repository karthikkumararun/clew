import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import type { GuardReport } from "./ipc";
import styles from "./Safety.module.css";

interface Pending {
  report: GuardReport;
  resolve: (confirmed: boolean) => void;
}

interface State {
  current: Pending | null;
  queue: Pending[];
  ask: (report: GuardReport) => Promise<boolean>;
  settle: (confirmed: boolean) => void;
}

const useConfirms = create<State>((set, get) => ({
  current: null,
  queue: [],
  ask: (report) =>
    new Promise((resolve) => {
      const p: Pending = { report, resolve };
      if (get().current) set((s) => ({ queue: [...s.queue, p] }));
      else set({ current: p });
    }),
  settle: (confirmed) => {
    const { current, queue } = get();
    current?.resolve(confirmed);
    set({ current: queue[0] ?? null, queue: queue.slice(1) });
  },
}));

/** Test helper: drop any open confirmation. */
export function clearConfirms(): void {
  useConfirms.setState({ current: null, queue: [] });
}

/** Show the confirmation a guard report asks for; resolves with whether the user confirmed. */
export const confirmGuarded = (report: GuardReport) => useConfirms.getState().ask(report);

const label = (env: string) => (env ? env[0].toUpperCase() + env.slice(1) : "");

const rowsLabel = (n: number) => `≈${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;

/** Mounted once in the workspace: the write confirmation and the type-the-name dialog. */
export function SafetyPromptHost() {
  const current = useConfirms((s) => s.current);
  const settle = useConfirms((s) => s.settle);
  if (!current) return null;
  return <ConfirmDialog report={current.report} onAnswer={settle} />;
}

function ConfirmDialog({
  report,
  onAnswer,
}: {
  report: GuardReport;
  onAnswer: (confirmed: boolean) => void;
}) {
  const typedRequired = report.decision === "typed_confirm";
  const [typed, setTyped] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const dangers = report.statements.flatMap((s) => (s.danger ? [s.danger] : []));
  const matches = !typedRequired || typed === report.typed;

  // Cancel is the default: focus it once the dialog has done its own focusing.
  useEffect(() => {
    if (typedRequired) return;
    const id = setTimeout(() => cancel.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [typedRequired]);

  const title = dangers[0] ?? "Confirm write";
  return (
    <Dialog
      title={title}
      maxWidth={560}
      onClose={() => onAnswer(false)}
      footer={
        <>
          <Button ref={cancel} variant="default" onClick={() => onAnswer(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!matches} onClick={() => onAnswer(true)}>
            {typedRequired ? "Run" : "Confirm"}
          </Button>
        </>
      }
    >
      <p className={styles.target}>
        <strong>{report.connection}</strong>
        {report.environment ? (
          <span className={styles.env} data-env={report.environment}>
            {" · "}
            {label(report.environment)}
          </span>
        ) : null}
      </p>
      <ul className={styles.statements} aria-label="Statements">
        {report.statements
          .filter((s) => s.class !== "read" && s.class !== "control")
          .map((s, i) => (
            <li key={i}>
              <code>{s.text}</code>
              {s.estimate !== undefined ? (
                <span className={styles.estimate}>{rowsLabel(s.estimate)}</span>
              ) : null}
              {s.danger && dangers[0] !== s.danger ? (
                <span className={styles.danger}>{s.danger}</span>
              ) : null}
            </li>
          ))}
      </ul>
      {typedRequired ? (
        <label className={styles.typed}>
          <span>
            This can't be undone easily. Type <strong>{report.typed}</strong> to continue.
          </span>
          <input
            value={typed}
            autoFocus
            spellCheck={false}
            aria-label="Connection name"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches) {
                e.preventDefault();
                onAnswer(true);
              }
            }}
          />
        </label>
      ) : null}
    </Dialog>
  );
}

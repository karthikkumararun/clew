import type { ReactNode } from "react";
import { create } from "zustand";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import styles from "./Console.module.css";

export interface Choice {
  id: string;
  label: string;
  variant?: "default" | "primary";
}

interface Prompt {
  title: string;
  body: ReactNode;
  choices: Choice[];
  resolve: (id: string | null) => void;
}

interface PromptState {
  current: Prompt | null;
  queue: Prompt[];
  ask: (p: Omit<Prompt, "resolve">) => Promise<string | null>;
  settle: (id: string | null) => void;
}

const usePrompts = create<PromptState>((set, get) => ({
  current: null,
  queue: [],
  ask: (p) =>
    new Promise((resolve) => {
      const prompt: Prompt = { ...p, resolve };
      if (get().current) set((s) => ({ queue: [...s.queue, prompt] }));
      else set({ current: prompt });
    }),
  settle: (id) => {
    const { current, queue } = get();
    current?.resolve(id);
    set({ current: queue[0] ?? null, queue: queue.slice(1) });
  },
}));

/**
 * Ask the user to choose; resolves with the chosen id, or `null` when the dialog is dismissed
 * (Esc or its close button), which always means "don't".
 */
export const askChoice = (p: Omit<Prompt, "resolve">) => usePrompts.getState().ask(p);

/** Mounted once in the workspace: confirmations raised by consoles. */
export function ConsolePromptHost() {
  const current = usePrompts((s) => s.current);
  const settle = usePrompts((s) => s.settle);
  if (!current) return null;
  return (
    <Dialog
      title={current.title}
      maxWidth={460}
      onClose={() => settle(null)}
      footer={
        <>
          {current.choices.map((c) => (
            <Button key={c.id} variant={c.variant ?? "default"} onClick={() => settle(c.id)}>
              {c.label}
            </Button>
          ))}
        </>
      }
    >
      <div className={styles.promptBody}>{current.body}</div>
    </Dialog>
  );
}

/** Test helper. */
export function clearPrompts() {
  usePrompts.setState({ current: null, queue: [] });
}

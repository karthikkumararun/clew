import { create } from "zustand";

/** Where the Copilot sign-in is (spec: ai-providers › GitHub Copilot sign-in). */
export type CopilotPhase =
  | "out"
  | "consent"
  | "downloading"
  | "starting"
  | "pending"
  | "in"
  | "no_access"
  | "expired"
  | "error";

interface CopilotState {
  phase: CopilotPhase;
  login: string | null;
  error: string | null;
}

export const useCopilot = create<CopilotState>(() => ({ phase: "out", login: null, error: null }));

/** "Signed in" when Copilot can serve completions. */
export const copilotSignedIn = () => useCopilot.getState().phase === "in";

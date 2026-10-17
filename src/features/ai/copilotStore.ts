import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { invoke, isTauri } from "../../lib/ipc";
import type { CopilotState } from "../../lib/ipc/generated/CopilotState";

/** Where the Copilot sign-in is (spec: ai-providers › GitHub Copilot sign-in). */
export type CopilotPhase = CopilotState["phase"];

interface CopilotStore {
  phase: CopilotPhase;
  login: string | null;
  /** Why it failed, for the error phase. */
  error: string | null;
  userCode: string | null;
  verificationUri: string | null;
  /** When the code expires (ms since the epoch). */
  expiresAt: number | null;
  /** The component's download size, shown when asking for consent. */
  downloadBytes: number | null;
  percent: number;
  /** Apply a state from the backend. */
  apply: (s: CopilotState) => void;
}

const IDLE = {
  login: null,
  error: null,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  downloadBytes: null,
  percent: 0,
};

export const useCopilot = create<CopilotStore>((set) => ({
  phase: "out",
  ...IDLE,
  apply: (s) => {
    switch (s.phase) {
      case "consent":
        return set({ ...IDLE, phase: "consent", downloadBytes: s.downloadBytes });
      case "downloading":
        return set({ ...IDLE, phase: "downloading", percent: s.percent });
      case "pending":
        return set({
          ...IDLE,
          phase: "pending",
          userCode: s.userCode,
          verificationUri: s.verificationUri,
          expiresAt: s.expiresAtMs,
        });
      case "in":
        return set({ ...IDLE, phase: "in", login: s.login });
      case "error":
        return set({ ...IDLE, phase: "error", error: s.message });
      default:
        return set({ ...IDLE, phase: s.phase });
    }
  },
}));

/** "Signed in" when Copilot can serve completions. */
export const copilotSignedIn = () => useCopilot.getState().phase === "in";

const call = (cmd: string) => (isTauri() ? invoke<void>(cmd) : Promise.resolve());

export const copilotBegin = () => call("copilot_begin");
export const copilotAcceptConsent = () => call("copilot_accept_consent");
export const copilotDeclineConsent = () => call("copilot_decline_consent");
export const copilotCheckNow = () => call("copilot_check_now");
export const copilotCancel = () => call("copilot_cancel");
export const copilotSignOut = () => call("copilot_sign_out");
export const copilotRefresh = () => call("copilot_refresh");

/**
 * Follow the backend's sign-in state: read it once, then listen for changes. Returns a disposer.
 */
export function startCopilotSync(): () => void {
  if (!isTauri()) return () => {};
  let off: (() => void) | null = null;
  let stopped = false;
  void listen<CopilotState>("copilot_state", (e) => useCopilot.getState().apply(e.payload)).then(
    (u) => (stopped ? u() : (off = u)),
  );
  void invoke<CopilotState>("copilot_state")
    .then((s) => useCopilot.getState().apply(s))
    .catch(() => {});
  void copilotRefresh().catch(() => {});
  return () => {
    stopped = true;
    off?.();
  };
}

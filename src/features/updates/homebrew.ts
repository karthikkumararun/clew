import { invoke, isTauri } from "../../lib/ipc";
import { useUpdates } from "./updateStore";

/** What a Homebrew install runs to update (spec: homebrew-packaging › Homebrew-managed updates). */
export const BREW_UPGRADE = "brew upgrade --cask clew";

/** Ask the backend whether this copy lives in a Homebrew Caskroom; remember the answer. */
export async function detectHomebrew(): Promise<void> {
  if (!isTauri()) return;
  try {
    useUpdates.getState().setHomebrew(await invoke<boolean>("installed_with_homebrew"));
  } catch {
    // Not Homebrew as far as we can tell: the in-app updater stays in charge.
  }
}

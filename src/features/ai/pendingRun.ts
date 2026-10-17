import { runCommand } from "../../shell/registry/commands";
import { askChoice } from "../console/prompts";
import { hasPendingReview, keepAll, undoAll } from "./review";

/**
 * Run with pending AI edits (spec: ai-assistant › Run with pending AI edits): ask what to do with
 * the hunks first. Resolves with whether the run should go ahead as requested.
 */
export async function resolvePendingBeforeRun(
  tabId: string,
  command: "console.run" | "console.runScript",
): Promise<boolean> {
  if (!hasPendingReview(tabId)) return true;
  const choice = await askChoice({
    title: "AI edits are waiting for review",
    body: "The assistant changed this console and you haven't kept or undone every change yet.",
    choices: [
      { id: "cancel", label: "Cancel" },
      { id: "original", label: "Run original" },
      { id: "keep", label: "Keep all and run", variant: "primary" },
    ],
  });
  if (choice === "keep") {
    keepAll(tabId);
    return true;
  }
  if (choice === "original") {
    undoAll(tabId);
    // The statement to run is now a different one: start the run again from the restored text.
    void runCommand(command);
  }
  return false;
}

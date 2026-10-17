import { useLayout } from "../../stores/layoutStore";
import { useNotices } from "../../stores/noticesStore";
import { activeConsoleTab } from "../console/commands";
import { getView } from "../console/editor/views";
import { getRuntime } from "../console/runtime";
import { assistantConnection, lastError } from "./activeContext";
import { useChat } from "./chatStore";
import { sendMessage } from "./send";

/**
 * Fix with AI / Explain error (spec: ai-assistant › Fix and explain errors): open the panel with
 * the failed statement and the error attached and send the request. Fix works in Edit mode so the
 * answer arrives as a reviewable diff; Explain works in Ask mode.
 */
export async function fixWithAi(kind: "fix" | "explain"): Promise<void> {
  const tab = activeConsoleTab();
  const connectionId = tab?.state.connectionId ?? assistantConnection();
  useLayout.getState().openSidePanel();
  useChat.getState().setView("chat");
  if (!tab || !connectionId) return;
  const error = lastError(connectionId);
  if (!error) {
    useNotices.getState().push("There is no error to look at");
    return;
  }
  const mode = kind === "fix" ? "edit" : "ask";
  useChat.getState().setMode(mode);
  // Where the failed statement sits in the editor, for the "console · lines 2–5" chip.
  const run = getRuntime(tab.id, connectionId).store.getState().lastRun;
  const view = getView(tab.id);
  let lines: [number, number] | undefined;
  if (run && view) {
    const doc = view.state.doc;
    const from = Math.min(run.offset, doc.length);
    const to = Math.min(run.offset + run.sql.length, doc.length);
    lines = [doc.lineAt(from).number, doc.lineAt(to).number];
  }
  await sendMessage(
    connectionId,
    kind === "fix" ? "Fix the error and explain why it happened." : "Explain this error.",
    {
      feature: "fix",
      mode,
      lines,
      attachments: [error],
    },
  );
}

import { resolvePendingBeforeRun } from "../ai/pendingRun";
import { getRuntime } from "./runtime";
import type { ConsoleRuntime, RunRequest } from "./runtime";
import { askChoice } from "./prompts";
import type { ConsoleTab } from "./state";

/**
 * Make sure nothing is running on the session. When something is, the user decides: cancel it
 * and carry on, or keep waiting (and do nothing).
 */
export async function ensureFree(runtime: ConsoleRuntime): Promise<boolean> {
  if (!runtime.busy) return true;
  const answer = await askChoice({
    title: "A query is still running",
    body: <p>Cancel the running query and run this one instead?</p>,
    choices: [
      { id: "keep", label: "Keep waiting" },
      { id: "cancel", label: "Cancel it and run", variant: "primary" },
    ],
  });
  if (answer !== "cancel") return false;
  await runtime.cancel();
  return runtime.whenIdle();
}

/** Run on the tab's session (asking first when it is busy). */
export async function submitRun(tab: ConsoleTab, req: RunRequest): Promise<boolean> {
  if (!(await resolvePendingBeforeRun(tab.id, req.script ? "console.runScript" : "console.run"))) {
    return false;
  }
  const runtime = getRuntime(tab.id, tab.state.connectionId);
  if (!(await ensureFree(runtime))) return false;
  await runtime.run(req);
  return true;
}

/** Explain on the tab's session (asking first when it is busy). */
export async function submitExplain(
  tab: ConsoleTab,
  req: { sql: string; offset: number; analyze: boolean },
): Promise<boolean> {
  if (!(await resolvePendingBeforeRun(tab.id, "console.run"))) return false;
  const runtime = getRuntime(tab.id, tab.state.connectionId);
  if (!(await ensureFree(runtime))) return false;
  await runtime.explain(req);
  return true;
}

import { getRuntime } from "./runtime";
import type { RunRequest } from "./runtime";
import { askChoice } from "./prompts";
import type { ConsoleTab } from "./state";

/**
 * Run on the tab's session. When something is already running the user decides: cancel it and
 * run this instead, or keep waiting (and run nothing).
 */
export async function submitRun(tab: ConsoleTab, req: RunRequest): Promise<boolean> {
  const runtime = getRuntime(tab.id, tab.state.connectionId);
  if (runtime.busy) {
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
    if (!(await runtime.whenIdle())) return false;
  }
  await runtime.run(req);
  return true;
}

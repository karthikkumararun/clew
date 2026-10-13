import { splitStatements, statementAt } from "../console/editor/statements";
import { getView } from "../console/editor/views";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { hasGraphElements } from "./graphModel";
import { getGraphRuntime, peekGraphRuntime } from "./runtime";
import { GRAPH_KIND } from "./state";
import type { GraphTab, GraphTabState, GraphView } from "./state";
import type { GraphMode } from "./types";

const tabById = (tabId: string) =>
  useWorkspace.getState().tabs.find((t) => t.id === tabId && t.kind === GRAPH_KIND) as
    GraphTab | undefined;

/** The active tab when it is a graph console. */
export function activeGraphTab(): GraphTab | null {
  const { tabs, activeTabId } = useWorkspace.getState();
  return (tabs.find((t) => t.id === activeTabId && t.kind === GRAPH_KIND) as GraphTab) ?? null;
}

/** The selection, else the statement under the cursor (statements end at `;`). */
export function cypherToRun(tabId: string): string | null {
  const view = getView(tabId);
  const tab = tabById(tabId);
  if (!view) {
    const text = tab?.state.text.trim();
    return text ? text : null;
  }
  const sel = view.state.selection.main;
  if (!sel.empty) {
    const picked = view.state.sliceDoc(sel.from, sel.to).trim();
    return picked ? picked : null;
  }
  const ranges = splitStatements(view.state.doc.toString(), "cypher", {
    blankLines: true,
    skipLeadingComments: true,
  });
  return statementAt(ranges, sel.head)?.text ?? null;
}

export const patchGraphTab = (tabId: string, patch: Partial<GraphTabState>) =>
  useWorkspace.getState().updateTabState<Partial<GraphTabState>>(tabId, patch);

/** The view to show after a run: the plan for EXPLAIN / PROFILE, the table when there is no graph. */
export function viewAfterRun(
  current: GraphView,
  mode: GraphMode,
  hasGraph: boolean,
  autoFrom: GraphView | null,
): { view: GraphView; autoFrom: GraphView | null } {
  if (mode !== "run") return { view: "plan", autoFrom: current === "plan" ? autoFrom : current };
  if (!hasGraph && (current === "graph" || current === "plan")) {
    return { view: "table", autoFrom: current === "plan" ? autoFrom : current };
  }
  if (autoFrom && hasGraph && (current === "table" || current === "plan")) {
    return { view: autoFrom, autoFrom: null };
  }
  if (current === "plan") return { view: hasGraph ? "graph" : "table", autoFrom: null };
  return { view: current, autoFrom };
}

const autoFromByTab = new Map<string, GraphView | null>();

/** Run `cypher` (or what the editor has at the cursor) in a graph console. */
export async function runGraphTab(
  tabId: string,
  mode: GraphMode = "run",
  cypher?: string,
): Promise<boolean> {
  const tab = tabById(tabId);
  if (!tab) return false;
  const text = cypher ?? cypherToRun(tabId);
  if (!text) {
    useNotices.getState().push("Nothing to run at the cursor");
    return false;
  }
  const runtime = getGraphRuntime(tab.id, tab.state.connectionId);
  const ok = await runtime.run(text, tab.state.params, mode);
  if (!ok) return false;
  const state = runtime.store.getState();
  const result = state.result;
  if (!result) return true;
  const fresh = tabById(tabId);
  if (!fresh) return true;
  const next = viewAfterRun(
    fresh.state.view,
    mode,
    hasGraphElements(result),
    autoFromByTab.get(tabId) ?? null,
  );
  autoFromByTab.set(tabId, next.autoFrom);
  if (next.view !== fresh.state.view) patchGraphTab(tabId, { view: next.view });
  return true;
}

export async function cancelGraphTab(tabId: string): Promise<void> {
  await peekGraphRuntime(tabId)?.cancel();
}

export const graphBusy = (): boolean => {
  const tab = activeGraphTab();
  return tab ? (peekGraphRuntime(tab.id)?.store.getState().running ?? false) : false;
};

export function forgetGraphTab(tabId: string): void {
  autoFromByTab.delete(tabId);
}

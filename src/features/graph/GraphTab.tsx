import { useStore } from "zustand";
import { Graph } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { registerCommand } from "../../shell/registry/commands";
import { registerStatusItem } from "../../shell/registry/statusItems";
import { registerTabKind } from "../../shell/registry/tabKinds";
import type { TabKind } from "../../shell/registry/tabKinds";
import { useWorkspace } from "../../stores/workspaceStore";
import { activeGraphTab, cancelGraphTab, forgetGraphTab, graphBusy, runGraphTab } from "./commands";
import { GraphBrowser } from "./GraphBrowser";
import { disposeGraphRuntime, getGraphRuntime } from "./runtime";
import { GRAPH_KIND, deserializeGraph, newGraphKey, serializeGraph } from "./state";
import type { GraphTabState } from "./state";
import type { GraphMode } from "./types";

function connectionOf(s: GraphTabState) {
  return useConnections.getState().file.connections.find((c) => c.id === s.connectionId);
}

const graphKind: TabKind<GraphTabState> = {
  kind: GRAPH_KIND,
  icon: Graph,
  title: () => "cypher",
  subtitle: (s) => connectionOf(s)?.name,
  env: (s) => {
    const c = connectionOf(s);
    return c ? BADGE_ENV[c.environment] : undefined;
  },
  serialize: serializeGraph,
  deserialize: deserializeGraph,
  render: ({ tab }) => <GraphBrowser key={tab.id} tab={tab} />,
  onClose: (tab) => {
    disposeGraphRuntime(tab.id);
    forgetGraphTab(tab.id);
  },
};

export function registerGraphTab(): () => void {
  return registerTabKind(graphKind);
}

/** Arguments of `graph.open`. */
export interface OpenGraphArgs {
  connectionId: string;
  database?: string;
  /** Initial Cypher text. */
  cypher?: string;
  /** Run `cypher` as soon as the console is open. */
  run?: boolean;
}

/** Open a new Cypher console on a Neo4j connection. Returns the tab id. */
export function openGraphConsole(args: OpenGraphArgs): string {
  const state: GraphTabState = {
    connectionId: args.connectionId,
    database: args.database ?? "",
    text: args.cypher ?? "",
    params: "{}",
    paramsOpen: false,
    view: "graph",
    inspectorOpen: true,
    ...(args.run && args.cypher ? { autoRun: true } : {}),
  };
  return useWorkspace
    .getState()
    .openTab({ kind: GRAPH_KIND, key: newGraphKey(args.connectionId), state });
}

function useActiveGraph() {
  return useWorkspace((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t && t.kind === GRAPH_KIND ? t : undefined;
  });
}

function AccessMode() {
  const tab = useActiveGraph();
  if (!tab) return null;
  return <AccessModeOf tabId={tab.id} connectionId={(tab.state as GraphTabState).connectionId} />;
}

function AccessModeOf({ tabId, connectionId }: { tabId: string; connectionId: string }) {
  const runtime = getGraphRuntime(tabId, connectionId);
  const readOnly = useStore(runtime.store, (s) => s.readOnly);
  return <>{`Access mode: ${readOnly ? "READ" : "WRITE"}`}</>;
}

function Hint() {
  const tab = useActiveGraph();
  return tab ? <>Double-click a node to expand · drag to rearrange</> : null;
}

/** Commands, shortcuts and status items of the graph console. Returns a disposer. */
export function registerGraphCommands(): () => void {
  const disposers = [
    registerCommand({
      id: "graph.open",
      title: "New Cypher console",
      category: "Graph",
      run: (arg) => {
        const a = (arg ?? {}) as Partial<OpenGraphArgs>;
        if (a.connectionId) openGraphConsole({ ...a, connectionId: a.connectionId });
      },
    }),
    registerCommand({
      id: "graph.profile",
      title: "Profile Cypher query",
      category: "Graph",
      run: async () => {
        const tab = activeGraphTab();
        if (tab) await runGraphTab(tab.id, "profile");
      },
    }),
    registerCommand({
      id: "graph.explain",
      title: "Explain Cypher query",
      category: "Graph",
      run: async () => {
        const tab = activeGraphTab();
        if (tab) await runGraphTab(tab.id, "explain");
      },
    }),
    registerStatusItem({
      id: "graph.access",
      side: "left",
      order: 7,
      render: () => <AccessMode />,
    }),
    registerStatusItem({ id: "graph.hint", side: "right", order: 24, render: () => <Hint /> }),
  ];
  return () => disposers.forEach((d) => d());
}

/** What the console's run, explain and cancel commands do when the active tab is a graph console. */
export const graphDelegate = {
  active: activeGraphTab,
  run: (mode: GraphMode = "run") => {
    const tab = activeGraphTab();
    return tab ? runGraphTab(tab.id, mode) : Promise.resolve(false);
  },
  cancel: () => {
    const tab = activeGraphTab();
    return tab ? cancelGraphTab(tab.id) : Promise.resolve();
  },
  busy: graphBusy,
};

import { useWorkspace } from "../stores/workspaceStore";
import { registerStatusItem } from "./registry/statusItems";
import { getTabKind } from "./registry/tabKinds";
import type { TabStatus } from "./registry/tabKinds";

function useActiveStatus(): TabStatus | undefined {
  const active = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  return active ? getTabKind(active.kind)?.status?.(active.state) : undefined;
}

function ConnectionState() {
  const c = useActiveStatus()?.connection;
  if (!c) return null;
  const connected = c.state === "connected";
  return (
    <>
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: connected ? "var(--success)" : "var(--text-dim)",
        }}
      />
      {connected ? `Connected · ${c.name}` : "Disconnected"}
    </>
  );
}

function ConnectionMeta({ field }: { field: "serverVersion" | "transport" }) {
  return <>{useActiveStatus()?.connection?.[field] ?? null}</>;
}

function ContextItems() {
  const items = useActiveStatus()?.right;
  return items?.length ? <>{items.join("   ")}</> : null;
}

/** Status-bar items driven by the active tab. */
export function registerTabStatusItems(): () => void {
  const disposers = [
    registerStatusItem({
      id: "tab.connection",
      side: "left",
      order: 0,
      render: () => <ConnectionState />,
    }),
    registerStatusItem({
      id: "tab.serverVersion",
      side: "left",
      order: 1,
      render: () => <ConnectionMeta field="serverVersion" />,
    }),
    registerStatusItem({
      id: "tab.transport",
      side: "left",
      order: 2,
      render: () => <ConnectionMeta field="transport" />,
    }),
    registerStatusItem({
      id: "tab.context",
      side: "right",
      order: 0,
      render: () => <ContextItems />,
    }),
  ];
  return () => disposers.forEach((d) => d());
}

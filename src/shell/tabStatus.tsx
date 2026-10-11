import { connectionStateOf } from "../connections/ConnectionChip";
import { useConnections } from "../connections/connectionsStore";
import { useWorkspace } from "../stores/workspaceStore";
import { registerStatusItem } from "./registry/statusItems";
import { getTabKind } from "./registry/tabKinds";
import type { TabStatus } from "./registry/tabKinds";

function useActiveStatus(): TabStatus | undefined {
  const active = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const connections = useConnections((s) => s.file.connections);
  const connected = useConnections((s) => s.connected);
  if (!active) return undefined;
  const own = getTabKind(active.kind)?.status?.(active.state);
  if (own?.connection) return own;
  // Tabs bound to a saved connection get the connection item for free.
  const bound = connectionStateOf(active.state);
  const connection = bound && connections.find((c) => c.id === bound.connectionId);
  if (!bound || !connection) return own;
  const info = connected[connection.id];
  return {
    ...own,
    connection: info
      ? {
          state: "connected",
          name: connection.name,
          serverVersion: `${info.server.product} ${info.server.version}`,
          transport: info.transport ?? undefined,
          environment: connection.environment,
        }
      : { state: "disconnected", name: connection.name, environment: connection.environment },
  };
}

function ConnectionState() {
  const c = useActiveStatus()?.connection;
  if (!c) return null;
  const connected = c.state === "connected";
  const production = c.environment === "production";
  return (
    <span
      data-env={c.environment}
      title={production ? "Production connection" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        ...(production
          ? {
              background: "var(--env-prod-badge-bg)",
              color: "var(--env-prod-badge-fg)",
              padding: "0 8px",
              borderRadius: "var(--radius)",
              alignSelf: "stretch",
            }
          : {}),
      }}
    >
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
      {production ? " · PRODUCTION" : ""}
    </span>
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

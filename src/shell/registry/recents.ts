import { create } from "zustand";
import type { DriverId, Environment } from "../../components/Badge";

export interface RecentConnection {
  id: string;
  name: string;
  driver: DriverId;
  env: Environment;
  /** e.g. `db.internal:5432/analytics · via bastion` */
  detail: string;
  /** Pre-formatted, e.g. `2 min ago`. */
  lastUsed: string;
}

export const useRecents = create<{ recents: RecentConnection[] }>(() => ({ recents: [] }));

/** Connection management feeds the Welcome screen's Recent list through this. */
export function setRecentConnections(recents: RecentConnection[]) {
  useRecents.setState({ recents });
}

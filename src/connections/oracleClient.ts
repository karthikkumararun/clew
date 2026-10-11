import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "../lib/ipc";
import { useSettings } from "../stores/settingsStore";
import { pickFolder } from "./files";

export interface ClientStatus {
  found: boolean;
  dir: string | null;
  version: string | null;
  searched: string[];
}

export interface OracleClient {
  /** `null` while unknown (checking, or outside the desktop app). */
  status: ClientStatus | null;
  /** Pick the Instant Client folder and remember it in Settings. */
  choose: () => Promise<void>;
}

export const INSTANT_CLIENT_URL = "oracle.com/database/technologies/instant-client";

/** Whether the Oracle Instant Client can be found, re-checked when the Settings folder changes. */
export function useOracleClient(active: boolean): OracleClient {
  const dir = useSettings((s) => s.settings.oracleClientDir);
  const set = useSettings((s) => s.set);
  const [status, setStatus] = useState<ClientStatus | null>(null);

  useEffect(() => {
    if (!active || !isTauri()) return;
    let live = true;
    invoke<ClientStatus>("oracle_client_status", { dir: dir || null })
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [active, dir]);

  const choose = useCallback(async () => {
    const picked = await pickFolder({ title: "Choose the Oracle Instant Client folder" });
    if (picked) set({ oracleClientDir: picked });
  }, [set]);

  return { status, choose };
}

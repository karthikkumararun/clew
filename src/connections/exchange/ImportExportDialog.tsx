import { Dialog } from "../../components/Dialog";
import { Close } from "../../components/icons";
import { useConnections } from "../connectionsStore";
import { ExportPanel } from "./ExportPanel";
import styles from "./ImportExport.module.css";

export type ExchangeTab = "export" | "import";

/** Mounted once in the workspace; shown when the store has an `exchange` request. */
export function ImportExportDialog() {
  const exchange = useConnections((s) => s.exchange);
  const setExchange = useConnections((s) => s.setExchange);
  if (!exchange) return null;
  const close = () => setExchange(null);
  const tabs: { id: ExchangeTab; label: string }[] = [
    { id: "export", label: "Export" },
    { id: "import", label: "Import" },
  ];
  return (
    <Dialog title="Connections" onClose={close} maxWidth={1040} hideHeader>
      <div className={styles.header}>
        <h1 className={styles.title}>Connections</h1>
        <div role="tablist" aria-label="Import or export" className={styles.tabs}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={exchange.tab === t.id}
              onClick={() => setExchange({ tab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className={styles.spacer} />
        <button type="button" className={styles.close} aria-label="Close" onClick={close}>
          <Close size={14} />
        </button>
      </div>
      {exchange.tab === "export" ? (
        <ExportPanel onDone={close} />
      ) : (
        <div style={{ padding: 24 }}>Import is not available yet.</div>
      )}
    </Dialog>
  );
}

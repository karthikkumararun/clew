import { useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Input } from "../../components/Input";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { Menu } from "../../components/Menu";
import { ChevronDown, Refresh } from "../../components/icons";
import { useNotices } from "../../stores/noticesStore";
import { REFRESH_PRESETS, canAutoRefresh, pauseText, refreshLabel } from "./autoRefresh";
import type { ConsoleRuntime } from "./runtime";
import styles from "./Console.module.css";

/** The toolbar's auto-refresh control (spec: sql-console › Auto-refresh). */
export function AutoRefreshMenu({ runtime }: { runtime: ConsoleRuntime }) {
  const auto = useStore(runtime.store, (s) => s.autoRefresh);
  const lastRun = useStore(runtime.store, (s) => s.lastRun);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  const [custom, setCustom] = useState<string | null>(null);

  const can = lastRun ? canAutoRefresh(lastRun.sql) : ({ ok: true } as const);
  const label = auto.paused ? pauseText(auto.paused) : refreshLabel(auto.ms);

  const choose = (ms: number) => {
    const refused = runtime.setAutoRefresh(ms);
    if (refused) useNotices.getState().push(refused);
  };

  return (
    <span className={styles.refreshWrap}>
      <button
        ref={opener}
        type="button"
        className={styles.exportButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Auto-refresh: ${label}`}
        title={can.ok ? undefined : can.reason}
        onClick={() => setOpen((o) => !o)}
      >
        <Refresh size={13} />
        {label}
        <ChevronDown size={12} />
      </button>
      {open ? (
        <>
          <div className={styles.menuScrim} onMouseDown={close} aria-hidden="true" />
          <AnchoredMenu anchor={opener} align="right">
            <Menu
              aria-label="Auto-refresh"
              items={[
                ...REFRESH_PRESETS.map((p) => ({
                  id: String(p.ms),
                  label: p.label,
                  disabled: p.ms > 0 && !can.ok,
                  hint: auto.ms === p.ms ? "✓" : undefined,
                })),
                { id: "custom", label: "Custom…", disabled: !can.ok },
              ]}
              onClose={close}
              onSelect={(id) => {
                close();
                if (id === "custom")
                  setCustom(String(Math.max(1, Math.round(auto.ms / 1000)) || 15));
                else choose(Number(id));
              }}
            />
          </AnchoredMenu>
        </>
      ) : null}
      {custom !== null ? (
        <Dialog
          title="Auto-refresh interval"
          maxWidth={360}
          onClose={() => setCustom(null)}
          footer={
            <>
              <Button variant="default" onClick={() => setCustom(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!(Number(custom) >= 1)}
                onClick={() => {
                  choose(Math.round(Number(custom) * 1000));
                  setCustom(null);
                }}
              >
                Start
              </Button>
            </>
          }
        >
          <label className={styles.customInterval}>
            Seconds between refreshes
            <Input
              dialog
              inputMode="numeric"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              aria-label="Seconds between refreshes"
            />
          </label>
        </Dialog>
      ) : null}
    </span>
  );
}

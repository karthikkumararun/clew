import { create } from "zustand";
import { DriverBadge, EnvDot } from "../../components/Badge";
import { Dialog } from "../../components/Dialog";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV, badgeDriver } from "../../connections/display";
import styles from "./Console.module.css";

interface PickerState {
  resolve: ((id: string | null) => void) | null;
  open: () => Promise<string | null>;
  settle: (id: string | null) => void;
}

const usePicker = create<PickerState>((set, get) => ({
  resolve: null,
  open: () =>
    new Promise((resolve) => {
      get().resolve?.(null); // a picker is already open: that one is abandoned
      set({ resolve });
    }),
  settle: (id) => {
    get().resolve?.(id);
    set({ resolve: null });
  },
}));

/** Ask the user which connection a new console is for. Resolves `null` when dismissed. */
export const pickConnection = () => usePicker.getState().open();

/** Mounted once in the workspace; shown while `pickConnection()` is pending. */
export function ConnectionPickerHost() {
  const open = usePicker((s) => s.resolve !== null);
  const settle = usePicker((s) => s.settle);
  const connections = useConnections((s) => s.file.connections);
  if (!open) return null;
  return (
    <Dialog title="New console" maxWidth={420} onClose={() => settle(null)}>
      <div className={styles.pickerBody}>
        {connections.length === 0 ? (
          <p className={styles.pickerEmpty}>There are no saved connections yet.</p>
        ) : (
          <>
            <p className={styles.pickerHint}>Choose a connection for the new console.</p>
            <ul className={styles.pickerList} aria-label="Connections">
              {connections.map((c) => (
                <li key={c.id}>
                  <button type="button" className={styles.pickerItem} onClick={() => settle(c.id)}>
                    <EnvDot env={BADGE_ENV[c.environment]} />
                    <DriverBadge driver={badgeDriver(c.driver)} />
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}

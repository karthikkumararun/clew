/**
 * The editable grid the keyboard acts on. The table editor and the console's result editing both
 * have staged changes and the same shortcuts (Mod+N, Mod+Backspace, Mod+Z, ...); the shortcut
 * registry allows one binding per key and scope, so each editing surface registers a provider
 * here and `editShortcuts.ts` binds the keys once and calls whichever surface is on screen.
 */
export interface GridEditTarget {
  /** Focus is somewhere an edit shortcut should be taken from the typed text field. */
  addRow(): void;
  cloneRows(): void;
  deleteRows(): void;
  undo(): void;
  redo(): void;
  revertSelection(): void;
  setNull(): void;
  setDefault(): void;
  /** Mod+Enter in a console result grid, Mod+S in the table editor. */
  submit(): void;
  submitAndCommit?(): void;
  paste?(asNewRows: boolean): void;
  /** Whether this surface has Mod+Enter / Mod+Alt+Shift+Enter (the console), or only Mod+S. */
  submitsWithEnter: boolean;
}

type Provider = () => GridEditTarget | undefined;

const providers = new Set<Provider>();

export function registerEditTarget(provider: Provider): () => void {
  providers.add(provider);
  return () => void providers.delete(provider);
}

/** The editing surface on screen, if any. */
export function activeEditTarget(): GridEditTarget | undefined {
  for (const p of providers) {
    const t = p();
    if (t) return t;
  }
  return undefined;
}

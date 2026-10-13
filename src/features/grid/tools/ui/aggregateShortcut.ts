/**
 * Contract: the Mod+Shift+C binding of the aggregate strip (spec: data-grid › Aggregate view).
 * The strip itself cannot own it (the grid scope is bound once, by the panel that shows the
 * grid), so the panel calls `registerAggregateShortcut(getText)` and keeps the returned
 * disposer. `getText` returns what to copy (`aggregateClipboardText` of the current result) or
 * null when nothing is numeric, in which case the key does nothing and the event is left alone.
 */
import { registerShortcut } from "../../../../shell/registry/shortcuts";

export async function copyAggregateText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function registerAggregateShortcut(getText: () => string | null): () => void {
  return registerShortcut({
    id: "grid.copyAggregate",
    keys: "Mod+Shift+C",
    scope: "grid",
    when: () => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return false;
      return getText() !== null;
    },
    run: () => {
      const text = getText();
      if (text !== null) void copyAggregateText(text);
    },
  });
}

import type { ReactNode } from "react";
import { create } from "zustand";

export interface StatusItem {
  id: string;
  side: "left" | "right";
  order?: number;
  /** Return null to hide the item (e.g. when the active editor does not supply it). */
  render: () => ReactNode;
}

interface StatusState {
  items: StatusItem[];
}

export const useStatusItems = create<StatusState>(() => ({ items: [] }));

export function registerStatusItem(item: StatusItem): () => void {
  useStatusItems.setState((s) => ({ items: [...s.items.filter((i) => i.id !== item.id), item] }));
  return () => useStatusItems.setState((s) => ({ items: s.items.filter((i) => i !== item) }));
}

export function sortedItems(items: StatusItem[], side: "left" | "right"): StatusItem[] {
  return items.filter((i) => i.side === side).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

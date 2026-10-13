import type { ComponentType, ReactNode } from "react";
import { create } from "zustand";

export type SlotName = "toolbarLeft" | "toolbarCenter" | "toolbarRight" | "sidebar";

export interface SlotItem {
  id: string;
  order?: number;
  render: () => ReactNode;
}

export interface SidePanelDef {
  id: string;
  title: string;
  icon: ComponentType<{ size?: number }>;
  render: () => ReactNode;
}

export interface BottomPanelDef {
  id: string;
  title: string;
  render: () => ReactNode;
}

interface SlotsState {
  slots: Record<SlotName, SlotItem[]>;
  sidePanel: SidePanelDef | null;
  bottomPanel: BottomPanelDef | null;
}

export const useSlots = create<SlotsState>(() => ({
  slots: { toolbarLeft: [], toolbarCenter: [], toolbarRight: [], sidebar: [] },
  sidePanel: null,
  bottomPanel: null,
}));

/** Contribute content to a shell slot (toolbar areas, sidebar body). Returns a disposer. */
export function registerSlotItem(slot: SlotName, item: SlotItem): () => void {
  useSlots.setState((s) => ({
    slots: {
      ...s.slots,
      [slot]: [...s.slots[slot].filter((i) => i.id !== item.id), item].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      ),
    },
  }));
  return () =>
    useSlots.setState((s) => ({
      slots: { ...s.slots, [slot]: s.slots[slot].filter((i) => i !== item) },
    }));
}

/** Register the right side panel (used by the AI assistant). A toolbar toggle appears with it. */
export function registerSidePanel(def: SidePanelDef): () => void {
  useSlots.setState({ sidePanel: def });
  return () => useSlots.setState((s) => (s.sidePanel === def ? { sidePanel: null } : s));
}

/** Register the bottom dock (used by the Sessions panel). Returns a disposer. */
export function registerBottomPanel(def: BottomPanelDef): () => void {
  useSlots.setState({ bottomPanel: def });
  return () => useSlots.setState((s) => (s.bottomPanel === def ? { bottomPanel: null } : s));
}

import { create } from "zustand";
import { getUiBool, setUiState } from "../lib/uiState";

export const NARROW_BREAKPOINT = 900;

interface LayoutState {
  sidebarOpen: boolean;
  sidePanelOpen: boolean;
  /** The bottom dock (Sessions panel). Visibility and height are restored after a restart. */
  bottomPanelOpen: boolean;
  /** Window narrower than 900px: sidebar is collapsed and can open as an overlay. */
  narrow: boolean;
  overlayOpen: boolean;
  toggleSidebar: () => void;
  closeOverlay: () => void;
  setNarrow: (narrow: boolean) => void;
  openSidePanel: () => void;
  closeSidePanel: () => void;
  toggleSidePanel: () => void;
  openBottomPanel: () => void;
  closeBottomPanel: () => void;
  toggleBottomPanel: () => void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarOpen: getUiBool("layout.sidebarOpen", true),
  sidePanelOpen: getUiBool("layout.sidePanelOpen", false),
  bottomPanelOpen: getUiBool("layout.bottomPanelOpen", false),
  narrow: false,
  overlayOpen: false,
  toggleSidebar: () => {
    if (get().narrow) {
      set((s) => ({ overlayOpen: !s.overlayOpen }));
      return;
    }
    const next = !get().sidebarOpen;
    setUiState("layout.sidebarOpen", String(next));
    set({ sidebarOpen: next });
  },
  closeOverlay: () => set({ overlayOpen: false }),
  setNarrow: (narrow) => set((s) => ({ narrow, overlayOpen: narrow ? s.overlayOpen : false })),
  openSidePanel: () => {
    setUiState("layout.sidePanelOpen", "true");
    set({ sidePanelOpen: true });
  },
  closeSidePanel: () => {
    setUiState("layout.sidePanelOpen", "false");
    set({ sidePanelOpen: false });
  },
  toggleSidePanel: () => (get().sidePanelOpen ? get().closeSidePanel() : get().openSidePanel()),
  openBottomPanel: () => {
    setUiState("layout.bottomPanelOpen", "true");
    set({ bottomPanelOpen: true });
  },
  closeBottomPanel: () => {
    setUiState("layout.bottomPanelOpen", "false");
    set({ bottomPanelOpen: false });
  },
  toggleBottomPanel: () =>
    get().bottomPanelOpen ? get().closeBottomPanel() : get().openBottomPanel(),
}));

/** Re-read persisted flags after the UI-state cache has been hydrated at startup. */
export function rehydrateLayout() {
  useLayout.setState({
    sidebarOpen: getUiBool("layout.sidebarOpen", true),
    sidePanelOpen: getUiBool("layout.sidePanelOpen", false),
    bottomPanelOpen: getUiBool("layout.bottomPanelOpen", false),
  });
}

import { registerCommand } from "../../shell/registry/commands";
import { registerSlotItem } from "../../shell/registry/slots";
import { useNotices } from "../../stores/noticesStore";
import { refreshIndex, startIndexing } from "./indexing";
import { usePalette } from "./paletteStore";
import { startRecentFiles } from "./recentFiles";
import { SearchButton } from "./SearchButton";

/**
 * The command palette: Mod+K, Mod+E, the toolbar button, and the background work that keeps the
 * object index fresh. Returns a disposer.
 */
export function registerPalette(): () => void {
  const disposers = [
    registerCommand({
      id: "palette.open",
      title: "Go to anything",
      category: "Navigate",
      shortcut: "Mod+K",
      run: () => usePalette.getState().show(),
    }),
    registerCommand({
      id: "palette.recent",
      title: "Recent files",
      category: "Navigate",
      shortcut: "Mod+E",
      run: () => usePalette.getState().show({ scope: "queries", preset: "recent" }),
    }),
    registerCommand({
      id: "palette.refreshIndex",
      title: "Refresh object index",
      category: "Navigate",
      run: async () => {
        await refreshIndex();
        useNotices.getState().push("Object index refreshed");
      },
    }),
    registerSlotItem("toolbarRight", {
      id: "palette.search",
      order: -10,
      render: () => <SearchButton />,
    }),
    startIndexing(),
    startRecentFiles(),
  ];
  return () => disposers.forEach((d) => d());
}

import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import "./styles/global.css";
import App from "./App";
import { boot } from "./boot";

// End-to-end builds only (`VITE_CLEW_E2E=1`): hooks the app for WebdriverIO. Dead code otherwise.
if (import.meta.env.VITE_CLEW_E2E === "1") await import("@wdio/tauri-plugin");

// End-to-end builds only (`VITE_CLEW_E2E=1`): let a journey run any registered command, for
// surfaces that have no menu yet. Dead code (and absent from the bundle) in other builds.
if (import.meta.env.VITE_CLEW_E2E === "1") {
  const { runCommand, listCommands } = await import("./shell/registry/commands");
  const w = window as unknown as { __clewE2E?: Record<string, unknown> };
  w.__clewE2E = {
    ...w.__clewE2E,
    runCommand: (id: string, arg?: unknown) => void runCommand(id, arg),
    commandIds: () => listCommands().map((c) => c.id),
  };
}

void boot().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});

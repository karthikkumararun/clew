import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import "./styles/global.css";
import App from "./App";
import { boot } from "./boot";

// End-to-end builds only (`VITE_CLEW_E2E=1`): hooks the app for WebdriverIO. Dead code otherwise.
if (import.meta.env.VITE_CLEW_E2E === "1") await import("@wdio/tauri-plugin");

void boot().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});

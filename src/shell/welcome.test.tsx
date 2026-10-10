import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Terminal } from "../components/icons";
import App from "../App";
import { setPlatformForTests } from "../lib/platform";
import { resetUiState } from "../lib/uiState";
import { DEFAULT_SETTINGS, useSettings } from "../stores/settingsStore";
import { useWorkspace } from "../stores/workspaceStore";
import { clearCommands, registerCommand } from "./registry/commands";
import { setRecentConnections } from "./registry/recents";
import { clearShortcuts } from "./registry/shortcuts";
import { useStatusItems } from "./registry/statusItems";
import { clearTabKinds, registerTabKind } from "./registry/tabKinds";

vi.mock("../lib/ipc", () => ({
  appPaths: async () => ({
    dataDir: "/Users/ada/Library/Application Support/Clew",
    connectionsFile: "/Users/ada/Library/Application Support/Clew/connections.json",
    connectionsFileDisplay: "~/Library/Application Support/Clew/connections.json",
    appVersion: "0.1.0",
  }),
}));

beforeEach(() => {
  resetUiState();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  useStatusItems.setState({ items: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  setRecentConnections([]);
  setPlatformForTests("mac");
  registerTabKind<{ name: string }>({
    kind: "console",
    icon: Terminal,
    title: (s) => s.name,
    render: () => <div data-testid="editor" />,
  });
});

describe("Welcome screen", () => {
  it("shows on first run with an empty Recent list", () => {
    render(<App />);
    expect(screen.getByTestId("welcome")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Clew", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("No connections yet")).toBeInTheDocument();
    expect(screen.getByText("Import connections")).toBeInTheDocument();
    expect(screen.getByText("Open a database file")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("is replaced by the editor when a tab opens, and returns after the last tab closes", () => {
    render(<App />);
    let id = "";
    act(() => {
      id = useWorkspace
        .getState()
        .openTab({ kind: "console", key: "c1", state: { name: "console" } });
    });
    expect(screen.queryByTestId("welcome")).not.toBeInTheDocument();
    expect(screen.getByTestId("editor")).toBeInTheDocument();
    act(() => useWorkspace.getState().requestClose(id));
    expect(screen.getByTestId("welcome")).toBeInTheDocument();
  });

  it("footer shows the real connections path and app version", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("connections-path")).toHaveTextContent(
        "~/Library/Application Support/Clew/connections.json",
      ),
    );
    expect(screen.getByTestId("welcome")).toHaveTextContent("v0.1.0");
  });

  it("renders platform-specific shortcut hints", () => {
    render(<App />);
    expect(screen.getByText("⌘K")).toBeInTheDocument();
    expect(screen.getByText("⌘↵")).toBeInTheDocument();
    expect(screen.getByText("⌘,")).toBeInTheDocument();
  });

  it("renders windows hints with Ctrl", () => {
    setPlatformForTests("windows");
    render(<App />);
    expect(screen.getByText("Ctrl+K")).toBeInTheDocument();
  });

  it("lists recent connections when there are some", () => {
    setRecentConnections([
      {
        id: "1",
        name: "prod-postgres",
        driver: "postgres",
        env: "production",
        detail: "db.internal:5432/analytics",
        lastUsed: "2 min ago",
      },
    ]);
    render(<App />);
    expect(screen.queryByText("No connections yet")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /prod-postgres/ })).toBeInTheDocument();
    expect(screen.getByText("PG")).toBeInTheDocument();
  });
});

describe("Welcome actions", () => {
  it("are no-ops until later changes register their commands", () => {
    render(<App />);
    expect(() =>
      fireEvent.click(screen.getByText("New connection", { selector: "span" })),
    ).not.toThrow();
  });

  it("run the matching command ids", async () => {
    const calls: [string, unknown][] = [];
    for (const id of [
      "connection.new",
      "connection.import",
      "file.openDatabase",
      "connection.fromUrl",
    ]) {
      registerCommand({
        id,
        title: id,
        category: "Test",
        run: (arg) => void calls.push([id, arg]),
      });
    }
    render(<App />);
    fireEvent.click(screen.getByText("New connection", { selector: "span" }));
    fireEvent.click(screen.getByText("Import connections"));
    fireEvent.click(screen.getByText("Open a database file"));
    fireEvent.change(screen.getByLabelText("Or paste a connection URL"), {
      target: { value: "  postgres://u@h:5432/db " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.map((c) => c[0])).toEqual([
      "connection.new",
      "connection.import",
      "file.openDatabase",
      "connection.fromUrl",
    ]);
    expect(calls[3][1]).toBe("postgres://u@h:5432/db");
  });

  it("Connect is disabled until a URL is entered", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });
});

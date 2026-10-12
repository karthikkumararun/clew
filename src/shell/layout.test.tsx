import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Star } from "../components/icons";
import App from "../App";
import { resetUiState } from "../lib/uiState";
import { setPlatformForTests } from "../lib/platform";
import { useLayout } from "../stores/layoutStore";
import { clearCommands } from "./registry/commands";
import { clearShortcuts } from "./registry/shortcuts";
import { registerSidePanel, useSlots } from "./registry/slots";
import { useStatusItems } from "./registry/statusItems";

function resetAll() {
  resetUiState();
  clearShortcuts();
  clearCommands();
  useStatusItems.setState({ items: [] });
  useSlots.setState({
    slots: { toolbarLeft: [], toolbarCenter: [], toolbarRight: [], sidebar: [] },
    sidePanel: null,
  });
  useLayout.setState({
    sidebarOpen: true,
    sidePanelOpen: false,
    narrow: false,
    overlayOpen: false,
  });
  setPlatformForTests("mac");
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
}

beforeEach(resetAll);

// Sizes (44px toolbar, 36px tab strip, 26px status bar, 272px sidebar, the macOS 78px inset) are
// measured on rendered boxes in e2e/design/D-01-metrics.e2e.ts and J-15; jsdom performs no layout,
// so asserting token declarations here would not observe them (defect class C5).

describe("workspace layout", () => {
  it("renders the brand mark", () => {
    render(<App />);
    const toolbar = within(screen.getByRole("banner"));
    expect(toolbar.getByText("Clew")).toBeInTheDocument();
    expect(toolbar.getByText("by ADK")).toBeInTheDocument();
  });

  it("starts with a 272px sidebar", () => {
    render(<App />);
    expect(screen.getByRole("separator", { name: /sidebar/ })).toHaveAttribute(
      "aria-valuenow",
      "272",
    );
  });

  it("clamps the sidebar to 240–420", () => {
    render(<App />);
    const handle = screen.getByRole("separator", { name: /sidebar/ });
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "420");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "240");
  });

  it("Mod+B collapses and expands the sidebar (spec: app-shell › Toggle the sidebar)", () => {
    render(<App />);
    expect(screen.getByRole("complementary", { name: "Explorer" })).toBeInTheDocument();
    fireEvent.keyDown(window, { code: "KeyB", key: "b", metaKey: true });
    expect(screen.queryByRole("complementary", { name: "Explorer" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { code: "KeyB", key: "b", metaKey: true });
    expect(screen.getByRole("complementary", { name: "Explorer" })).toBeInTheDocument();
  });

  it("sidebar open state persists", () => {
    render(<App />);
    fireEvent.keyDown(window, { code: "KeyB", key: "b", metaKey: true });
    expect(localStorage.getItem("clew:layout.sidebarOpen")).toBe("false");
  });

  it("collapses automatically below 900px and opens as an overlay (spec: app-shell › Narrow window)", () => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true, writable: true });
    render(<App />);
    expect(screen.queryByRole("complementary", { name: "Explorer" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { code: "KeyB", key: "b", metaKey: true });
    expect(screen.getByRole("complementary", { name: "Explorer" })).toBeInTheDocument();
    // widening the window closes the overlay and restores the inline sidebar
    act(() => {
      Object.defineProperty(window, "innerWidth", {
        value: 1200,
        configurable: true,
        writable: true,
      });
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("separator", { name: /sidebar/ })).toBeInTheDocument();
  });
});

describe("side panel", () => {
  const register = () =>
    registerSidePanel({
      id: "ai",
      title: "AI assistant",
      icon: Star,
      render: () => <p>panel body</p>,
    });

  it("is absent until a feature registers one", () => {
    render(<App />);
    expect(screen.queryByRole("button", { name: /Toggle AI assistant/ })).not.toBeInTheDocument();
  });

  it("opens at 380px, clamps to 320–560 and restores its open state", () => {
    register();
    const { unmount } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI assistant" }));
    const handle = screen.getByRole("separator", { name: /AI assistant/ });
    expect(handle).toHaveAttribute("aria-valuenow", "380");
    expect(screen.getByText("panel body")).toBeInTheDocument();
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "560");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "320");
    unmount();

    // relaunch: open state and width come back
    useLayout.setState({
      sidePanelOpen: localStorage.getItem("clew:layout.sidePanelOpen") === "true",
    });
    register();
    render(<App />);
    expect(screen.getByRole("separator", { name: /AI assistant/ })).toHaveAttribute(
      "aria-valuenow",
      "320",
    );
  });

  it("closes from its header", () => {
    register();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI assistant" }));
    fireEvent.click(screen.getByRole("button", { name: "Close AI assistant" }));
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
  });
});

describe("status bar", () => {
  it("shows only the app version on the right when nothing else is registered (spec: app-shell › No active connection)", () => {
    render(<App />);
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    expect(bar).toHaveTextContent(/^Clew v\d/);
  });
});

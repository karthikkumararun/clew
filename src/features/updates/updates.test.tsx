import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "../../stores/workspaceStore";
import { UpdateDialog } from "./UpdateDialog";
import {
  UNVERIFIED,
  checkForUpdates,
  clearPendingUpdate,
  describeError,
  installAndRestart,
} from "./updater";
import { useUpdates } from "./updateStore";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  ask: vi.fn(),
  settle: vi.fn(),
  tauri: true,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => mocks.check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => mocks.relaunch() }));
vi.mock("../../lib/ipc", () => ({ isTauri: () => mocks.tauri }));
vi.mock("../console/prompts", () => ({ askChoice: (p: unknown) => mocks.ask(p) }));
vi.mock("../console/quit", () => ({ settleTransactionsBeforeQuit: () => mocks.settle() }));

const found = (over: Record<string, unknown> = {}) => ({
  version: "0.2.0",
  body: "- Faster grid\n- Fixes",
  date: "2026-11-01",
  downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  ...over,
});

const dirtyConsole = {
  id: "t1",
  kind: "console",
  key: "k",
  state: { connectionId: "c", text: "SELECT 2", savedText: "SELECT 1", filePath: "/s/a.sql" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tauri = true;
  mocks.settle.mockResolvedValue(true);
  clearPendingUpdate();
  useUpdates.setState({ status: { kind: "idle" }, dialogOpen: false });
  useWorkspace.setState({ tabs: [], activeTabId: null });
});

describe("opt-in updates (spec: release-packaging › Opt-in updates)", () => {
  it("shows the version and notes when an update is available", async () => {
    mocks.check.mockResolvedValue(found());
    await checkForUpdates();
    expect(useUpdates.getState().status).toMatchObject({ kind: "available", version: "0.2.0" });
    render(<UpdateDialog />);
    expect(screen.getByText("Clew 0.2.0")).toBeTruthy();
    expect(screen.getByLabelText("Release notes")).toHaveTextContent("Faster grid");
    expect(mocks.relaunch).not.toHaveBeenCalled(); // nothing installs until the user agrees
  });

  it("says so when Clew is up to date", async () => {
    mocks.check.mockResolvedValue(null);
    await checkForUpdates();
    expect(useUpdates.getState().status.kind).toBe("upToDate");
    expect(useUpdates.getState().dialogOpen).toBe(false);
  });

  it("the startup check records an update without opening the dialog", async () => {
    mocks.check.mockResolvedValue(found());
    await checkForUpdates({ silent: true });
    expect(useUpdates.getState().status.kind).toBe("available");
    expect(useUpdates.getState().dialogOpen).toBe(false);
  });

  it("installs and restarts only after Install and restart", async () => {
    const update = found();
    mocks.check.mockResolvedValue(update);
    await checkForUpdates();
    render(<UpdateDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    act(() => useUpdates.getState().openDialog());
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalled());
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  /** (spec: release-packaging › Tampered update) */
  it("discards a package that doesn't verify and never restarts", async () => {
    const update = found({
      downloadAndInstall: vi.fn().mockRejectedValue(new Error("signature verification failed")),
    });
    mocks.check.mockResolvedValue(update);
    await checkForUpdates();
    await installAndRestart();
    expect(useUpdates.getState().status).toEqual({ kind: "error", message: UNVERIFIED });
    expect(UNVERIFIED).toBe("Update couldn't be verified");
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  /** (spec: release-packaging › Unsaved work on restart) */
  it("asks to save unsaved work before installing, and installs nothing", async () => {
    const update = found();
    mocks.check.mockResolvedValue(update);
    await checkForUpdates();
    useWorkspace.setState({ tabs: [dirtyConsole], activeTabId: "t1" });
    mocks.ask.mockResolvedValue("back");
    await installAndRestart();
    expect(mocks.ask).toHaveBeenCalled();
    expect(mocks.ask.mock.calls[0][0].body).toContain("a.sql");
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("asks about open transactions first and stops when the user cancels", async () => {
    const update = found();
    mocks.check.mockResolvedValue(update);
    await checkForUpdates();
    mocks.settle.mockResolvedValue(false);
    await installAndRestart();
    expect(mocks.settle).toHaveBeenCalled();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("reports a failed check", async () => {
    mocks.check.mockRejectedValue(new Error("network down"));
    await checkForUpdates();
    expect(useUpdates.getState().status).toEqual({
      kind: "error",
      message: "Couldn't check for updates: network down",
    });
  });

  it("does nothing outside the desktop app", async () => {
    mocks.tauri = false;
    await checkForUpdates();
    expect(mocks.check).not.toHaveBeenCalled();
    expect(useUpdates.getState().status.kind).toBe("error");
  });
});

describe("describeError", () => {
  it("treats signature problems as an unverifiable update, others as plain failures", () => {
    expect(describeError(new Error("Minisign signature mismatch"), "install")).toBe(UNVERIFIED);
    expect(describeError(new Error("disk full"), "install")).toBe(
      "Couldn't install the update: disk full",
    );
  });
});

describe("update dialog for Homebrew installs (spec: homebrew-packaging › Homebrew-managed updates)", () => {
  it("offers the brew command, not Install and restart", () => {
    useUpdates.setState({
      status: { kind: "available", version: "0.2.0", notes: "n" },
      dialogOpen: true,
      homebrew: true,
    });
    render(<UpdateDialog />);
    expect(screen.getByText("brew upgrade --cask clew")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install and restart" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    useUpdates.setState({ homebrew: false });
  });
});

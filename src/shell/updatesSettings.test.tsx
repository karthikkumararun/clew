import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../stores/settingsStore";
import { useUpdates } from "../features/updates/updateStore";
import { SettingsDialog } from "./SettingsDialog";

const check = vi.hoisted(() => vi.fn());
vi.mock("../features/updates/updater", async (orig) => ({
  ...(await orig<typeof import("../features/updates/updater")>()),
  checkForUpdates: () => check(),
}));

beforeEach(() => {
  check.mockReset();
  useUpdates.setState({ status: { kind: "idle" }, dialogOpen: false, homebrew: false });
  useSettings.setState({ dialogOpen: true, section: "Updates" });
});

describe("Settings › Updates (spec: release-packaging › Opt-in updates)", () => {
  it("has the automatic check off by default and a Check now button", () => {
    render(<SettingsDialog />);
    expect(
      screen.getByRole("checkbox", { name: /Check for updates automatically/ }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(check).toHaveBeenCalled();
  });

  it("shows the result of a check", async () => {
    render(<SettingsDialog />);
    useUpdates.setState({ status: { kind: "available", version: "0.2.0", notes: "n" } });
    expect(await screen.findByText(/Version 0.2.0 is available/)).toBeTruthy();
    useUpdates.setState({ status: { kind: "upToDate", checkedAt: 1 } });
    await waitFor(() => expect(screen.getByText(/up to date/)).toBeTruthy());
  });
});

describe("Settings › Updates for Homebrew installs (spec: homebrew-packaging › Homebrew-managed updates)", () => {
  beforeEach(() => useUpdates.setState({ homebrew: true }));

  it("shows the brew upgrade command with Copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<SettingsDialog />);
    expect(screen.getByText(/Installed with Homebrew/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("brew upgrade --cask clew");
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
  });

  it("says how to update instead of offering to install", async () => {
    render(<SettingsDialog />);
    useUpdates.setState({ status: { kind: "available", version: "0.2.0", notes: "n" } });
    expect(await screen.findByText(/Version 0.2.0 is available. Update with:/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
  });
});

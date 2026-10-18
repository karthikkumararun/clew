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
  useUpdates.setState({ status: { kind: "idle" }, dialogOpen: false });
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

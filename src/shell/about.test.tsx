import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutDialog, AboutLink } from "./AboutDialog";
import { useAbout } from "./aboutStore";

const invoke = vi.fn();
vi.mock("../lib/ipc", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const REPORT = "Clew diagnostics\nVersion: 0.1.0";

describe("About dialog (spec: release-qa › Diagnostics bundle)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) =>
      cmd === "about_info"
        ? Promise.resolve({ version: "0.1.0", commit: "abc1234" })
        : Promise.resolve(REPORT),
    );
    useAbout.setState({ open: false });
  });

  it("opens from the version in the status bar and shows version and commit", async () => {
    render(
      <>
        <AboutLink />
        <AboutDialog />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Clew v/ }));
    expect(await screen.findByText(/Version 0\.1\.0 \(abc1234\)/)).toBeTruthy();
  });

  it("copies the report and confirms (spec: release-qa › Copy diagnostics)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useAbout.setState({ open: true });
    render(<AboutDialog />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REPORT));
    expect((await screen.findByRole("status")).textContent).toBe("Copied");
  });

  it("says so when the report cannot be copied", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
    });
    useAbout.setState({ open: true });
    render(<AboutDialog />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy diagnostics" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn");
  });
});

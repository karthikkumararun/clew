import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotPanel, countdown } from "./CopilotPanel";
import { useCopilot } from "./copilotStore";

const calls = vi.hoisted(() => ({
  begin: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
  check: vi.fn(),
  cancel: vi.fn(),
  signOut: vi.fn(),
  open: vi.fn(),
}));

vi.mock("./copilotStore", async (orig) => {
  const real = await orig<typeof import("./copilotStore")>();
  return {
    ...real,
    copilotBegin: () => calls.begin(),
    copilotAcceptConsent: () => calls.accept(),
    copilotDeclineConsent: () => calls.decline(),
    copilotCheckNow: () => calls.check(),
    copilotCancel: () => calls.cancel(),
    copilotSignOut: () => calls.signOut(),
  };
});
vi.mock("../../lib/external", () => ({ openExternal: (u: string) => calls.open(u) }));

beforeEach(() => {
  vi.clearAllMocks();
  act(() => useCopilot.getState().apply({ phase: "out" }));
});
afterEach(() => vi.useRealTimers());

describe("Copilot sign-in states (spec: ai-providers › GitHub Copilot sign-in)", () => {
  it("offers Sign in with GitHub and never asks for a password", () => {
    render(<CopilotPanel />);
    expect(screen.getByText(/never sees your password/)).toBeTruthy();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(calls.begin).toHaveBeenCalled();
  });

  it("asks for consent before downloading, naming the size", () => {
    act(() =>
      useCopilot
        .getState()
        .apply({ phase: "consent", version: "1.0.0", downloadBytes: 96 * 1024 * 1024 }),
    );
    render(<CopilotPanel />);
    const box = screen.getByRole("group", { name: "Download the Copilot component" });
    expect(box).toHaveTextContent("about 96 MB");
    expect(box).toHaveTextContent("checksum");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(calls.decline).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download and continue" }));
    expect(calls.accept).toHaveBeenCalled();
  });

  it("shows download progress with a Cancel", () => {
    act(() => useCopilot.getState().apply({ phase: "downloading", percent: 42 }));
    render(<CopilotPanel />);
    expect(screen.getByRole("status")).toHaveTextContent("Downloading the Copilot component… 42%");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.decline).toHaveBeenCalled();
  });

  it("shows the code in large type with a countdown, Check now and Cancel", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    act(() =>
      useCopilot.getState().apply({
        phase: "pending",
        userCode: "8F2K-Q7MD",
        verificationUri: "https://github.com/login/device",
        expiresAtMs: 1_000_000 + 14 * 60_000 + 32_000,
      }),
    );
    render(<CopilotPanel />);
    expect(screen.getByTestId("copilot-code")).toHaveTextContent("8F2K-Q7MD");
    expect(screen.getByText(/Waiting for authorization/)).toHaveTextContent("expires in 14:32");
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByText(/Waiting for authorization/)).toHaveTextContent("expires in 14:30");
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(calls.check).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.cancel).toHaveBeenCalled();
  });

  it("copies the code and opens GitHub's page", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    act(() =>
      useCopilot.getState().apply({
        phase: "pending",
        userCode: "AAAA-BBBB",
        verificationUri: "https://github.com/login/device",
        expiresAtMs: Date.now() + 60_000,
      }),
    );
    render(<CopilotPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Copy & open browser" }));
    expect(writeText).toHaveBeenCalledWith("AAAA-BBBB");
    expect(calls.open).toHaveBeenCalledWith("https://github.com/login/device");
  });

  it("shows who is signed in, with Sign out", () => {
    act(() => useCopilot.getState().apply({ phase: "in", login: "ada" }));
    render(<CopilotPanel />);
    expect(screen.getByText(/Signed in as/)).toHaveTextContent("@ada");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(calls.signOut).toHaveBeenCalled();
  });

  it.each([
    [{ phase: "no_access" as const }, "This GitHub account doesn't have Copilot access"],
    [{ phase: "expired" as const }, "The code expired — try again"],
    [
      { phase: "error" as const, message: "Couldn't download the Copilot component: 503" },
      "Couldn't download the Copilot component: 503",
    ],
  ])("explains %j and lets the user try again", (state, text) => {
    act(() => useCopilot.getState().apply(state));
    render(<CopilotPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent(text);
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  });
});

describe("countdown", () => {
  it("formats minutes and seconds, never below zero", () => {
    expect(countdown(872_000)).toBe("14:32");
    expect(countdown(5_000)).toBe("0:05");
    expect(countdown(-10)).toBe("0:00");
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { lineDiff } from "./lineDiff";
import { OutputLog, entryText } from "./OutputLog";
import type { OutputEntry } from "./runtime";

const entry = (id: number, extra: Partial<OutputEntry> = {}): OutputEntry => ({
  id,
  at: Date.UTC(2026, 9, 13, 10, 20, 30),
  kind: "ok",
  statement: `SELECT ${id} FROM orders`,
  message: "5 rows · 12 ms",
  tx: "auto",
  ...extra,
});

describe("Output tab tools (spec: sql-console › Output tab tools)", () => {
  it("shows statement, outcome, duration and the transaction mode", () => {
    render(<OutputLog entries={[entry(1, { tx: "manual" })]} />);
    const log = screen.getByRole("log", { name: "Output" });
    expect(within(log).getByText("SELECT 1 FROM orders")).toBeInTheDocument();
    expect(within(log).getByText(/5 rows · 12 ms/)).toBeInTheDocument();
    expect(within(log).getByText(/manual transaction/)).toBeInTheDocument();
  });

  it("Clear empties the log through the callback (spec: sql-console › Clear)", () => {
    const onClear = vi.fn();
    render(<OutputLog entries={[entry(1)]} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("toggles soft wrap, auto-scroll and pause", () => {
    render(<OutputLog entries={[entry(1)]} />);
    const log = screen.getByRole("log", { name: "Output" });
    expect(log).toHaveAttribute("data-wrap", "true");
    const wrap = screen.getByRole("button", { name: "Soft wrap" });
    fireEvent.click(wrap);
    expect(log).toHaveAttribute("data-wrap", "false");
    expect(wrap).toHaveAttribute("aria-pressed", "false");
    const pause = screen.getByRole("button", { name: "Pause output" });
    fireEvent.click(pause);
    expect(screen.getByRole("button", { name: "Resume output" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("pausing stops following new entries while they keep arriving", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { rerender } = render(<OutputLog entries={[entry(1)]} />);
    const before = scroll.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Pause output" }));
    rerender(<OutputLog entries={[entry(1), entry(2)]} />);
    expect(screen.getByText("SELECT 2 FROM orders")).toBeInTheDocument();
    expect(scroll.mock.calls.length).toBe(before);
  });

  it("the context menu copies the entry or its statement", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText, readText: vi.fn().mockResolvedValue("") } });
    render(<OutputLog entries={[entry(7)]} />);
    fireEvent.contextMenu(screen.getByText("SELECT 7 FROM orders"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy statement" }));
    expect(writeText).toHaveBeenCalledWith("SELECT 7 FROM orders");
    fireEvent.contextMenu(screen.getByText("SELECT 7 FROM orders"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(writeText).toHaveBeenLastCalledWith(entryText(entry(7)));
  });

  it("Compare with clipboard shows what differs", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(), readText: vi.fn().mockResolvedValue("SELECT 7 FROM users") },
    });
    render(<OutputLog entries={[entry(7)]} />);
    fireEvent.contextMenu(screen.getByText("SELECT 7 FROM orders"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compare with clipboard" }));
    const diff = await screen.findByLabelText("Differences");
    await waitFor(() => expect(diff.textContent).toContain("SELECT 7 FROM users"));
    expect(diff.textContent).toContain("SELECT 7 FROM orders");
  });
});

describe("line diff", () => {
  it("marks removed and added lines and keeps common ones", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
    ]);
    expect(lineDiff("same", "same").every((l) => l.kind === "same")).toBe(true);
  });
});

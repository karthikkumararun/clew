import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCommands, registerCommand } from "../../shell/registry/commands";
import { resolvePendingBeforeRun } from "./pendingRun";
import { useReview } from "./review";

const ask = vi.hoisted(() => vi.fn());
const review = vi.hoisted(() => ({ keepAll: vi.fn(), undoAll: vi.fn(), pending: true }));

vi.mock("../console/prompts", () => ({ askChoice: (p: unknown) => ask(p) }));
vi.mock("./review", () => ({
  hasPendingReview: () => review.pending,
  keepAll: (id: string) => review.keepAll(id),
  undoAll: (id: string) => review.undoAll(id),
  useReview: { setState: vi.fn() },
}));

const run = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  review.pending = true;
  clearCommands();
  registerCommand({ id: "console.run", title: "Run", category: "Console", run });
  void useReview;
});

describe("run with pending AI edits (spec: ai-assistant › Run with pending AI edits)", () => {
  it("asks first, with the three choices", async () => {
    ask.mockResolvedValue("cancel");
    await resolvePendingBeforeRun("t1", "console.run");
    const p = ask.mock.calls[0][0];
    expect(p.choices.map((c: { label: string }) => c.label)).toEqual([
      "Cancel",
      "Run original",
      "Keep all and run",
    ]);
  });

  it("Keep all and run keeps the hunks and lets the run go ahead", async () => {
    ask.mockResolvedValue("keep");
    expect(await resolvePendingBeforeRun("t1", "console.run")).toBe(true);
    expect(review.keepAll).toHaveBeenCalledWith("t1");
  });

  it("Run original undoes the edit and starts the run again from the restored text", async () => {
    ask.mockResolvedValue("original");
    expect(await resolvePendingBeforeRun("t1", "console.run")).toBe(false);
    expect(review.undoAll).toHaveBeenCalledWith("t1");
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
  });

  it("Cancel, or dismissing the dialog, runs nothing and changes nothing", async () => {
    for (const answer of ["cancel", null]) {
      ask.mockResolvedValue(answer);
      expect(await resolvePendingBeforeRun("t1", "console.run")).toBe(false);
    }
    expect(review.keepAll).not.toHaveBeenCalled();
    expect(review.undoAll).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("doesn't ask when nothing is pending", async () => {
    review.pending = false;
    expect(await resolvePendingBeforeRun("t1", "console.run")).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

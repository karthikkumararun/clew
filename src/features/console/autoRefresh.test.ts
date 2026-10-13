import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "../../stores/workspaceStore";
import { canAutoRefresh, pauseReason, pauseText, refreshLabel } from "./autoRefresh";
import { ConsoleRuntime } from "./runtime";

vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("../../lib/ipc/drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  queryExecute: vi.fn(),
  queryCancel: vi.fn(),
  queryFetchMore: vi.fn(),
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
  completionSnapshot: vi.fn(),
  introspectChildren: vi.fn(),
  isAppError: () => false,
}));

describe("auto-refresh rules (spec: sql-console › Auto-refresh)", () => {
  it("labels the setting", () => {
    expect(refreshLabel(10_000)).toBe("Every 10 s");
    expect(refreshLabel(60_000)).toBe("Every min");
    expect(refreshLabel(120_000)).toBe("Every 2 min");
    expect(refreshLabel(0)).toBe("Off");
  });

  it("is unavailable for writes with the spec's wording (spec: sql-console › Not for writes)", () => {
    expect(canAutoRefresh("SELECT * FROM orders")).toEqual({ ok: true });
    expect(canAutoRefresh("UPDATE orders SET a = 1 RETURNING id")).toEqual({
      ok: false,
      reason: "Only read statements can refresh automatically",
    });
  });

  it("pauses for pending changes, a hidden tab and a background window", () => {
    const base = { pendingChanges: 0, tabVisible: true, windowFocused: true };
    expect(pauseReason(base)).toBeNull();
    expect(pauseReason({ ...base, pendingChanges: 2 })).toBe("pending");
    expect(pauseReason({ ...base, tabVisible: false })).toBe("hidden");
    expect(pauseReason({ ...base, windowFocused: false })).toBe("background");
    expect(pauseText("pending")).toBe("Paused: pending changes");
  });
});

describe("the console's refresh timer", () => {
  let runtime: ConsoleRuntime;
  let run: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    document.hasFocus = () => true;
    useWorkspace.setState({ activeTabId: "t1" });
    runtime = new ConsoleRuntime("t1", "c1");
    runtime.store.setState({ lastRun: { sql: "SELECT 1", script: false, offset: 0 } });
    run = vi.spyOn(runtime, "run").mockResolvedValue();
  });
  afterEach(() => {
    runtime.close();
    vi.useRealTimers();
  });

  it("re-runs the statement every 10 seconds and shows the setting (spec: sql-console › Every 10 seconds)", async () => {
    expect(runtime.setAutoRefresh(10_000)).toBeNull();
    expect(runtime.store.getState().autoRefresh.ms).toBe(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("refuses a write statement", () => {
    runtime.store.setState({
      lastRun: { sql: "UPDATE t SET a = 1 RETURNING a", script: false, offset: 0 },
    });
    expect(runtime.setAutoRefresh(5_000)).toBe("Only read statements can refresh automatically");
    expect(runtime.store.getState().autoRefresh.ms).toBe(0);
  });

  it("pauses while there are pending changes, then carries on (spec: sql-console › Pending changes)", async () => {
    let pending = 3;
    runtime.pendingChanges = () => pending;
    runtime.setAutoRefresh(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    expect(runtime.store.getState().autoRefresh.paused).toBe("pending");
    pending = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(runtime.store.getState().autoRefresh.paused).toBeNull();
  });

  it("pauses while the tab is not the active one", async () => {
    useWorkspace.setState({ activeTabId: "other" });
    runtime.setAutoRefresh(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    expect(runtime.store.getState().autoRefresh.paused).toBe("hidden");
  });

  it("Off stops the timer", async () => {
    runtime.setAutoRefresh(5_000);
    runtime.setAutoRefresh(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).not.toHaveBeenCalled();
  });
});

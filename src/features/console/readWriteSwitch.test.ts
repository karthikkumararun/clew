import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSessionReadOnly } from "../safety/ipc";
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

describe("switching a session to read-write (spec: production-safeguards › Toggle)", () => {
  let runtime: ConsoleRuntime;
  let end: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(setSessionReadOnly).mockClear();
    runtime = new ConsoleRuntime("t1", "c1");
    vi.spyOn(runtime, "ensureSession").mockResolvedValue("s1");
    end = vi.spyOn(runtime, "endTransaction").mockResolvedValue(true);
  });

  it("rolls back a transaction that was opened read-only, so the next statement can write", async () => {
    runtime.store.setState({ readOnly: true, txOpen: true, txPending: 1 });
    await runtime.setReadOnly(false);
    expect(end).toHaveBeenCalledWith(false);
    expect(setSessionReadOnly).toHaveBeenCalledWith("s1", false);
    expect(runtime.store.getState().readOnly).toBe(false);
    expect(runtime.store.getState().output.slice(-1)[0]?.message).toContain("rolled back");
  });

  it("leaves the switch undone when the transaction cannot be rolled back", async () => {
    end.mockResolvedValue(false);
    runtime.store.setState({ readOnly: true, txOpen: true });
    await runtime.setReadOnly(false);
    expect(setSessionReadOnly).not.toHaveBeenCalled();
    expect(runtime.store.getState().readOnly).toBe(true);
  });

  it("does not touch a read-write transaction or switching to read-only", async () => {
    runtime.store.setState({ readOnly: false, txOpen: true });
    await runtime.setReadOnly(true);
    expect(end).not.toHaveBeenCalled();
    runtime.store.setState({ readOnly: true, txOpen: false });
    await runtime.setReadOnly(false);
    expect(end).not.toHaveBeenCalled();
  });
});

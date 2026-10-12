import { describe, expect, it, vi } from "vitest";
import type { ResultEvent } from "./generated/ResultEvent";

// A Tauri Channel delivers its messages separately from the command's response, so the response
// can settle first. The real app showed an empty table editor because of it (found by the
// end-to-end run, J-05); `queryExecute` must settle only after the run's closing event arrived.
const channels: { onmessage?: (e: ResultEvent) => void }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (e: ResultEvent) => void;
    constructor() {
      channels.push(this);
    }
  },
}));
const invokeMock = vi.fn();
vi.mock("./index", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const summary = { rows_affected: null, elapsed_ms: 7, has_more: false };

describe("queryExecute (spec: sql-console › Run current statement)", () => {
  it("settles only after the events the server sent before replying have been delivered", async () => {
    const { queryExecute } = await import("./drivers");
    // The response comes first; the channel messages follow a moment later.
    invokeMock.mockImplementation(async () => {
      const channel = channels[channels.length - 1];
      setTimeout(() => {
        channel.onmessage?.({ event: "columns", result_id: 1, statement: 0, columns: [] });
        channel.onmessage?.({ event: "rows", result_id: 1, rows: [[{ kind: "int", value: 1 }]] });
        channel.onmessage?.({ event: "done", result_id: 1, summary });
      }, 20);
      return summary;
    });
    const seen: string[] = [];
    await queryExecute("s1", { sql: "select 1" } as never, (e) => seen.push(e.event));
    expect(seen).toEqual(["columns", "rows", "done"]);
  });

  it("does not hang when the closing event never comes", async () => {
    vi.useFakeTimers();
    const { queryExecute } = await import("./drivers");
    invokeMock.mockResolvedValue(summary);
    const settled = queryExecute("s1", { sql: "select 1" } as never, () => {});
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(settled).resolves.toEqual(summary);
    vi.useRealTimers();
  });
});

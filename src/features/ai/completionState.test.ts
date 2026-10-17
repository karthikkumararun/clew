import { beforeEach, describe, expect, it } from "vitest";
import { ERROR_LIMIT, PAUSE_MS, completionsPaused, useCompletionState } from "./completionState";

beforeEach(() => useCompletionState.setState({ failures: 0, pausedUntil: null }));

describe("error backoff (spec: ai-inline-completion › Provider unavailable)", () => {
  it("pauses for 60 seconds after three failures in a row", () => {
    const s = useCompletionState.getState();
    s.recordFailure(1000);
    s.recordFailure(1000);
    expect(completionsPaused(1000)).toBe(false);
    s.recordFailure(1000);
    expect(ERROR_LIMIT).toBe(3);
    expect(completionsPaused(1000 + PAUSE_MS - 1)).toBe(true);
    expect(completionsPaused(1000 + PAUSE_MS)).toBe(false);
  });

  it("a success in between resets the count", () => {
    const s = useCompletionState.getState();
    s.recordFailure(0);
    s.recordFailure(0);
    s.recordSuccess();
    s.recordFailure(0);
    s.recordFailure(0);
    expect(completionsPaused(0)).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { CELLS_MIME } from "./clipboard";
import { readClipboard, writeCopy } from "./clipboardIo";

afterEach(() => vi.unstubAllGlobals());

describe("clipboardIo", () => {
  it("falls back to writeText without ClipboardItem and still remembers the typed copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue("a\r\n");
    vi.stubGlobal("ClipboardItem", undefined);
    Object.assign(navigator, { clipboard: { writeText, readText } });
    await writeCopy("a\r\n", '{"version":1,"rows":[]}');
    expect(writeText).toHaveBeenCalledWith("a\r\n");
    expect(await readClipboard()).toEqual({ text: "a\r\n", typed: '{"version":1,"rows":[]}' });
  });

  it("writes both types when ClipboardItem works and reads the private one back", async () => {
    class Item {
      constructor(public data: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", Item);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { write } });
    await writeCopy("t", "{}");
    expect(Object.keys((write.mock.calls[0][0][0] as Item).data).sort()).toEqual(
      ["text/plain", CELLS_MIME].sort(),
    );
  });
});

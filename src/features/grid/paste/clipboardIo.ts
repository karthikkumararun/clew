/**
 * Clipboard IO for copy and paste (no React).
 *
 * Contract:
 *  - `writeCopy(text, typed)` writes the TSV as `text/plain` and the typed payload under
 *    `CELLS_MIME`. When the WebView refuses the private type (or has no `ClipboardItem`), it falls
 *    back to plain text. The last copy is also remembered in memory, so a paste of the same text
 *    inside Clew keeps NULL vs '' and exact decimals even if the private type did not survive.
 *  - `readClipboard()` returns `{ text, typed }` from `navigator.clipboard.read()` when it works,
 *    else `readText()`. `typed` is null when absent. It throws when the clipboard is unreadable.
 *  - `copyEventData(event, text, typed)` is the synchronous variant for a DOM `copy` event.
 */

import { CELLS_MIME } from "./clipboard";

let last: { text: string; typed: string } | null = null;

export async function writeCopy(text: string, typed: string): Promise<void> {
  last = { text, typed };
  const clip = navigator.clipboard;
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (Item && typeof clip.write === "function") {
    try {
      await clip.write([
        new Item({
          "text/plain": new Blob([text], { type: "text/plain" }),
          [CELLS_MIME]: new Blob([typed], { type: CELLS_MIME }),
        }),
      ]);
      return;
    } catch {
      // Fall through to plain text.
    }
  }
  await clip.writeText(text);
}

export function copyEventData(event: ClipboardEvent, text: string, typed: string): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  last = { text, typed };
  data.setData("text/plain", text);
  try {
    data.setData(CELLS_MIME, typed);
  } catch {
    // Some WebViews only accept standard types.
  }
  return true;
}

export interface ClipboardContent {
  text: string;
  typed: string | null;
}

export async function readClipboard(): Promise<ClipboardContent> {
  const clip = navigator.clipboard;
  let text: string | null = null;
  let typed: string | null = null;
  if (typeof clip.read === "function") {
    try {
      for (const item of await clip.read()) {
        if (typed === null && item.types.includes(CELLS_MIME))
          typed = await (await item.getType(CELLS_MIME)).text();
        if (text === null && item.types.includes("text/plain"))
          text = await (await item.getType("text/plain")).text();
      }
    } catch {
      // Permission or type refusal: fall back to readText below.
    }
  }
  if (text === null) text = await clip.readText();
  if (typed === null && last && last.text === text) typed = last.typed;
  return { text, typed };
}

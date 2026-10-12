import { appendFileSync, writeFileSync } from "node:fs";

/** Answer the app's next native file/folder dialogs, in order. `null` cancels that dialog. */
export function queueDialog(queueFile: string, ...answers: (string | null)[]): void {
  appendFileSync(queueFile, answers.map((a) => `${a ?? "CANCEL"}\n`).join(""));
}

export function clearDialogs(queueFile: string): void {
  writeFileSync(queueFile, "");
}

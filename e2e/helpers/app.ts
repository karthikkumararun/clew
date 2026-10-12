import { browser, $ } from "@wdio/globals";
import { clearDialogs } from "./dialogs";
import type { TestDataDir } from "./dataDir";

/**
 * Restart the app in place: same process id, same environment, same data directory. Use it after
 * seeding files (connections.json) so the app reads them at start-up, and to prove what survives
 * a restart. The embedded WebDriver server dies with the old process and the new process serves
 * the same port, so a new session is opened afterwards.
 */
export async function launchApp(data: Pick<TestDataDir, "dialogQueue">): Promise<void> {
  // The app saves workspace state 500ms after the last change (src/shell/session.ts); a restart
  // is not a window close, so give those saves time to land. No UI signal exists to wait on.
  await browser.pause(1000);
  clearDialogs(data.dialogQueue);
  // The process dies mid-request, so this call is expected to fail; wdio retries it against the
  // new process, which reports an unknown session. Both outcomes mean the restart happened.
  await browser
    .execute(() => {
      const w = window as unknown as { __TAURI__: { core: { invoke(c: string): Promise<void> } } };
      void w.__TAURI__.core.invoke("e2e_restart");
    })
    .catch(() => {});
  await browser.pause(1000);
  await browser.reloadSession();
  await waitForShell();
}

/** The window is up: the explorer is there whether or not it has connections. */
export async function waitForShell(timeout = 30_000): Promise<void> {
  await $("aria/Explorer").waitForDisplayed({ timeout });
}

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
  const started = await timeOrigin();
  // The process dies mid-request, so this call is expected to fail; wdio retries it against the
  // new process, which reports an unknown session. Both outcomes mean the restart happened.
  await browser
    .execute(() => {
      const w = window as unknown as { __TAURI__: { core: { invoke(c: string): Promise<void> } } };
      void w.__TAURI__.core.invoke("e2e_restart");
    })
    .catch(() => {});
  // A restart is quick on macOS but takes seconds on Linux and Windows. Open a session only once
  // the page belongs to the new process (a different `timeOrigin`) and has stayed up, so it
  // never lands on the dying one. The port itself cannot be watched: on macOS it is re-bound
  // faster than any poll could see it closed.
  await reopenSession(started);
  await waitForShell();
}

/**
 * The window is up: the toolbar is there in every layout. (The explorer is not: a saved layout can
 * hide it, and the app must still start.)
 */
export async function waitForShell(timeout = 30_000): Promise<void> {
  await $("aria/Toggle sidebar").waitForDisplayed({ timeout });
}

const timeOrigin = () => browser.execute(() => performance.timeOrigin);

async function reopenSession(before: number, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await browser.reloadSession();
      const first = await timeOrigin();
      if (first !== before) {
        await browser.pause(1000);
        if ((await timeOrigin()) === first) return;
      }
    } catch {
      /* the server is not up yet, or it was the old process dying */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the app did not come back within ${timeoutMs}ms of the restart`);
}

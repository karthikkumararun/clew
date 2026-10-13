import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestDataDir {
  /** The app's data directory (`CLEW_DATA_DIR`): settings, connections.json, clew.db. */
  dir: string;
  /** Text file the test appends dialog answers to (`CLEW_E2E_DIALOG_QUEUE`). */
  dialogQueue: string;
  cleanup(): void;
}

/**
 * Create the run's temporary profile. The name has a space and a non-ASCII letter on purpose:
 * path handling bugs show up here first. Called once by `wdio.conf.ts` before the app starts,
 * because the service spawns the app a single time per run with this environment. Each spec file
 * therefore gets its own run (see `scripts/qa-e2e.ts`), which is what keeps files isolated.
 */
export function createDataDir(prefix = "clew e2e é-"): TestDataDir {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir: join(root, "data"),
    dialogQueue: join(root, "dialogs.txt"),
    cleanup: () => {
      // The app stops a moment after the run (see e2e_exit), and Windows will not delete files a
      // running process holds: retry, then leave the temp folder to the OS rather than turn a
      // passed run into a failed one.
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM") throw e;
      }
    },
  };
}

/** The run's data directory, as set up by `wdio.conf.ts`. */
export function withDataDir(): Pick<TestDataDir, "dir" | "dialogQueue"> {
  const dir = process.env.CLEW_DATA_DIR;
  const dialogQueue = process.env.CLEW_E2E_DIALOG_QUEUE;
  if (!dir || !dialogQueue) throw new Error("CLEW_DATA_DIR is not set: run through wdio.conf.ts");
  return { dir, dialogQueue };
}

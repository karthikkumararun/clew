import { browser } from "@wdio/globals";

/** Call a Tauri command of the app under test (the `e2e_*` ones exist only in test builds). */
export async function invokeCommand<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const out = await browser.executeAsync(
    (
      cmd: string,
      a: Record<string, unknown>,
      done: (r: { ok?: unknown; err?: string }) => void,
    ) => {
      const w = window as unknown as {
        __TAURI__: { core: { invoke(c: string, a: Record<string, unknown>): Promise<unknown> } };
      };
      w.__TAURI__.core.invoke(cmd, a).then(
        (ok) => done({ ok }),
        (err) => done({ err: String(err) }),
      );
    },
    command,
    args,
  );
  if (out.err !== undefined) throw new Error(`${command} failed: ${out.err}`);
  return out.ok as T;
}

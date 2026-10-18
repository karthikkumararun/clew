import { browser } from "@wdio/globals";

/**
 * Press `Mod+<key>` (Cmd on macOS, Ctrl elsewhere), optionally with Shift, as a keydown/keyup pair
 * on the focused element. The embedded WebDriver's key chords do not set modifier flags on the
 * events the page sees, so shortcut handlers never fire from `browser.keys([Key.Command, ...])`.
 * Plain typing still goes through `browser.keys`.
 */
export async function pressMod(
  key: string,
  opts: { shift?: boolean; alt?: boolean; selector?: string } = {},
): Promise<void> {
  const mac = process.platform === "darwin";
  await browser.execute(
    (k: string, shift: boolean, alt: boolean, isMac: boolean, selector: string | null) => {
      const target =
        (selector ? document.querySelector(selector) : null) ??
        document.activeElement ??
        document.body;
      const init: KeyboardEventInit = {
        key: k,
        code:
          k.length === 1 && /[a-z]/i.test(k)
            ? `Key${k.toUpperCase()}`
            : k === "Enter"
              ? "Enter"
              : undefined,
        metaKey: isMac,
        ctrlKey: !isMac,
        shiftKey: shift,
        altKey: alt,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
    },
    key,
    opts.shift ?? false,
    opts.alt ?? false,
    mac,
    opts.selector ?? null,
  );
}

/**
 * Press a key with explicit modifiers (keydown/keyup on the focused element), for chords where
 * the platform differs: Cmd+Shift+Left on macOS is Shift+Home on Windows.
 */
export async function pressKey(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): Promise<void> {
  await browser.execute(
    (k: string, m: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }) => {
      const target = document.activeElement ?? document.body;
      const init: KeyboardEventInit = {
        key: k,
        metaKey: !!m.meta,
        ctrlKey: !!m.ctrl,
        shiftKey: !!m.shift,
        altKey: !!m.alt,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
    },
    key,
    mods,
  );
}

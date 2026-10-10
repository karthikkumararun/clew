import { formatShortcut, setPlatformForTests } from "../../lib/platform";
import { registerCommand, clearCommands, runCommand, commandShortcutLabel } from "./commands";
import {
  clearShortcuts,
  dispatchShortcut,
  installShortcutListener,
  registerShortcut,
  runEditorShortcut,
} from "./shortcuts";

function key(init: KeyboardEventInit & { target?: Element }) {
  const { target, ...rest } = init;
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...rest });
  (target ?? document.body).dispatchEvent(e);
  return e;
}

afterEach(() => {
  clearShortcuts();
  clearCommands();
  setPlatformForTests(null);
  document.body.innerHTML = "";
});

describe("formatShortcut", () => {
  it("renders macOS symbols", () => {
    expect(formatShortcut("Mod+K", "mac")).toBe("⌘K");
    expect(formatShortcut("Mod+Shift+Alt+K", "mac")).toBe("⌥⇧⌘K");
    expect(formatShortcut("Mod+Enter", "mac")).toBe("⌘↵");
  });

  it("renders Windows names", () => {
    expect(formatShortcut("Mod+K", "windows")).toBe("Ctrl+K");
    expect(formatShortcut("Mod+Shift+Alt+K", "windows")).toBe("Ctrl+Shift+Alt+K");
    expect(formatShortcut("Mod+,", "windows")).toBe("Ctrl+,");
  });
});

describe("shortcut registry", () => {
  it("maps Mod to Cmd on macOS and Ctrl on Windows", () => {
    const run = vi.fn();
    const off = installShortcutListener();
    registerShortcut({ id: "k", keys: "Mod+K", scope: "global", run });

    setPlatformForTests("mac");
    key({ code: "KeyK", key: "k", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
    key({ code: "KeyK", key: "k", metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);

    setPlatformForTests("windows");
    key({ code: "KeyK", key: "k", metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    key({ code: "KeyK", key: "k", ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(2);
    off();
  });

  it("matches bracket shortcuts by physical key even though Shift changes e.key", () => {
    setPlatformForTests("mac");
    const run = vi.fn();
    const off = installShortcutListener();
    registerShortcut({ id: "next", keys: "Mod+Shift+]", scope: "global", run });
    key({ code: "BracketRight", key: "}", metaKey: true, shiftKey: true });
    expect(run).toHaveBeenCalledOnce();
    off();
  });

  it("rejects a second registration of the same keys in the same scope", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = vi.fn();
    const second = vi.fn();
    registerShortcut({ id: "a", keys: "Mod+J", scope: "global", run: first });
    const off = registerShortcut({
      id: "b",
      keys: "mod+j".replace("mod", "Mod"),
      scope: "global",
      run: second,
    });
    setPlatformForTests("mac");
    dispatchShortcut(new KeyboardEvent("keydown", { code: "KeyJ", key: "j", metaKey: true }));
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    off();
    spy.mockRestore();
  });

  it("allows the same keys in different scopes", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerShortcut({ id: "a", keys: "Mod+/", scope: "global", run: () => {} });
    registerShortcut({ id: "b", keys: "Mod+/", scope: "editor", run: () => {} });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("editor scope wins over global for focus inside the editor", () => {
    setPlatformForTests("mac");
    const global = vi.fn();
    const editor = vi.fn();
    registerShortcut({ id: "g", keys: "Mod+/", scope: "global", run: global });
    registerShortcut({ id: "e", keys: "Mod+/", scope: "editor", run: editor });
    const off = installShortcutListener();
    const holder = document.createElement("div");
    holder.dataset.shortcutScope = "editor";
    const inner = document.createElement("div");
    holder.appendChild(inner);
    document.body.appendChild(holder);

    key({ code: "Slash", key: "/", metaKey: true, target: inner });
    expect(editor).toHaveBeenCalledOnce();
    expect(global).not.toHaveBeenCalled();

    key({ code: "Slash", key: "/", metaKey: true });
    expect(global).toHaveBeenCalledOnce();
    off();
  });

  it("does not run a global handler for an event the editor already handled", () => {
    setPlatformForTests("mac");
    const global = vi.fn();
    registerShortcut({ id: "g", keys: "Mod+/", scope: "global", run: global });
    const off = installShortcutListener();
    const inner = document.createElement("div");
    inner.addEventListener("keydown", (e) => e.preventDefault()); // e.g. a CodeMirror keymap
    document.body.appendChild(inner);
    key({ code: "Slash", key: "/", metaKey: true, target: inner });
    expect(global).not.toHaveBeenCalled();
    off();
  });

  it("runEditorShortcut forces the editor scope for CodeMirror keymaps", () => {
    setPlatformForTests("windows");
    const editor = vi.fn();
    registerShortcut({ id: "e", keys: "Mod+Enter", scope: "editor", run: editor });
    const handled = runEditorShortcut(
      new KeyboardEvent("keydown", { code: "Enter", key: "Enter", ctrlKey: true }),
    );
    expect(handled).toBe(true);
    expect(editor).toHaveBeenCalledOnce();
  });

  it("suppresses global shortcuts while a modal dialog is open", () => {
    setPlatformForTests("mac");
    const run = vi.fn();
    registerShortcut({ id: "g", keys: "Mod+W", scope: "global", run });
    const dlg = document.createElement("div");
    dlg.setAttribute("data-dialog-root", "");
    document.body.appendChild(dlg);
    dispatchShortcut(new KeyboardEvent("keydown", { code: "KeyW", key: "w", metaKey: true }));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("command registry", () => {
  it("binds a command's shortcut and runs it", async () => {
    setPlatformForTests("mac");
    const run = vi.fn();
    registerCommand({ id: "x.do", title: "Do", category: "X", shortcut: "Mod+Shift+D", run });
    expect(commandShortcutLabel("x.do")).toBe("⇧⌘D");
    dispatchShortcut(
      new KeyboardEvent("keydown", { code: "KeyD", key: "D", metaKey: true, shiftKey: true }),
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it("treats unknown command ids as a no-op", async () => {
    await expect(runCommand("connection.new")).resolves.toBe(false);
  });
});

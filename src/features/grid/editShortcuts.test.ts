import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPlatformForTests } from "../../lib/platform";
import { clearShortcuts, dispatchShortcut, listShortcuts } from "../../shell/registry/shortcuts";
import { registerEditTarget } from "./editTarget";
import type { GridEditTarget } from "./editTarget";
import { registerGridEditShortcuts } from "./editShortcuts";
import { registerTableShortcuts } from "../table-editor/actions";

function target(extra: Partial<GridEditTarget> = {}): GridEditTarget {
  return {
    submitsWithEnter: true,
    addRow: vi.fn(),
    cloneRows: vi.fn(),
    deleteRows: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    revertSelection: vi.fn(),
    setNull: vi.fn(),
    setDefault: vi.fn(),
    submit: vi.fn(),
    submitAndCommit: vi.fn(),
    paste: vi.fn(),
    ...extra,
  };
}

/** A keydown inside the grid scope (the results panel marks itself `data-shortcut-scope="grid"`). */
function press(code: string, key: string, mods: Partial<KeyboardEventInit> = {}, scope = "grid") {
  const host = document.createElement("div");
  host.setAttribute("data-shortcut-scope", scope);
  const inner = document.createElement("button");
  host.appendChild(inner);
  document.body.appendChild(host);
  const e = new KeyboardEvent("keydown", {
    code,
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...mods,
  });
  Object.defineProperty(e, "target", { value: inner });
  const handled = dispatchShortcut(e);
  host.remove();
  return handled;
}

describe("result shortcuts (spec: result-editing › Result shortcuts)", () => {
  let off: () => void = () => {};
  beforeEach(() => {
    setPlatformForTests("mac");
    clearShortcuts();
    off = registerGridEditShortcuts();
  });
  afterEach(() => off());

  it("registers every grid-scope binding of the spec with no conflict", () => {
    const keys = listShortcuts()
      .filter((b) => b.scope === "grid")
      .map((b) => b.keys);
    for (const k of [
      "Mod+Enter",
      "Mod+Alt+Shift+Enter",
      "Mod+N",
      "Mod+Shift+D",
      "Mod+Backspace",
      "Mod+Z",
      "Mod+Shift+Z",
      "Mod+Alt+Z",
      "Mod+Alt+N",
      "Mod+Alt+D",
      "Mod+V",
      "Mod+Shift+V",
    ]) {
      expect(keys).toContain(k);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the table editor's own registration does not collide with them", () => {
    const offTable = registerTableShortcuts();
    const grid = listShortcuts().filter((b) => b.scope === "grid");
    const canonical = grid.map((b) => b.keys);
    expect(new Set(canonical).size).toBe(canonical.length);
    offTable();
  });

  it("Mod+N, Mod+Shift+D, Mod+Backspace, Mod+Z, Mod+Shift+Z, Mod+Alt+Z, Mod+Alt+N and Mod+Alt+D act on the surface on screen", () => {
    const t = target();
    const offTarget = registerEditTarget(() => t);
    expect(press("KeyN", "n")).toBe(true);
    expect(t.addRow).toHaveBeenCalled();
    press("KeyD", "d", { shiftKey: true });
    expect(t.cloneRows).toHaveBeenCalled();
    press("Backspace", "Backspace");
    expect(t.deleteRows).toHaveBeenCalled();
    press("KeyZ", "z");
    expect(t.undo).toHaveBeenCalled();
    press("KeyZ", "z", { shiftKey: true });
    expect(t.redo).toHaveBeenCalled();
    press("KeyZ", "z", { altKey: true });
    expect(t.revertSelection).toHaveBeenCalled();
    press("KeyN", "n", { altKey: true });
    expect(t.setNull).toHaveBeenCalled();
    press("KeyD", "d", { altKey: true });
    expect(t.setDefault).toHaveBeenCalled();
    offTarget();
  });

  it("Mod+Enter submits from the grid, Mod+Alt+Shift+Enter submits and commits (spec: result-editing › Mod+Enter by focus)", () => {
    const t = target();
    const offTarget = registerEditTarget(() => t);
    expect(press("Enter", "Enter")).toBe(true);
    expect(t.submit).toHaveBeenCalledOnce();
    press("Enter", "Enter", { altKey: true, shiftKey: true });
    expect(t.submitAndCommit).toHaveBeenCalledOnce();
    offTarget();
  });

  it("with focus in the SQL editor scope the grid's Mod+Enter does not take the key", () => {
    const t = target();
    const offTarget = registerEditTarget(() => t);
    expect(press("Enter", "Enter", {}, "editor")).toBe(false);
    expect(t.submit).not.toHaveBeenCalled();
    offTarget();
  });

  it("the table editor keeps Mod+S and does not take Mod+Enter", () => {
    const t = target({ submitsWithEnter: false });
    const offTarget = registerEditTarget(() => t);
    expect(press("KeyS", "s")).toBe(true);
    expect(t.submit).toHaveBeenCalledOnce();
    expect(press("Enter", "Enter")).toBe(false);
    offTarget();
  });

  it("paste goes to the surface only when it can paste", () => {
    const t = target();
    const offTarget = registerEditTarget(() => t);
    press("KeyV", "v");
    expect(t.paste).toHaveBeenCalledWith(false);
    press("KeyV", "v", { shiftKey: true });
    expect(t.paste).toHaveBeenLastCalledWith(true);
    offTarget();
    const noPaste = target({ paste: undefined });
    const off2 = registerEditTarget(() => noPaste);
    expect(press("KeyV", "v")).toBe(false);
    off2();
  });

  it("does nothing when no surface is editable", () => {
    expect(press("KeyN", "n")).toBe(false);
  });
});

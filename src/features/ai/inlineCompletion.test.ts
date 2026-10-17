import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, currentGhost, firstWord, inlineCompletion } from "./inlineCompletion";
import type { Suggestions } from "./inlineCompletion";

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
});

interface Call {
  prefix: string;
  suffix: string;
  signal: AbortSignal;
  resolve: (s: Suggestions) => void;
}

let calls: Call[] = [];
let enabled = true;
let popup = false;
let view: EditorView;
let host: HTMLDivElement;

function mount(doc = "SELECT * FROM orders o WHERE ") {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        inlineCompletion({
          enabled: () => enabled,
          popupOpen: () => popup,
          source: (prefix, suffix, signal) =>
            new Promise((resolve) => calls.push({ prefix, suffix, signal, resolve })),
        }),
      ],
    }),
  });
}

/** Type into the editor at the cursor, as the user would. */
const type = (text: string) => {
  const at = view.state.selection.main.head;
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: "input.type",
  });
};

const key = (k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  return runScopeHandlers(view, e, "editor");
};

const pause = async () => {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
};

const answer = async (suggestions: string[], provider = "Copilot") => {
  calls[calls.length - 1].resolve({ suggestions, provider });
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  enabled = true;
  popup = false;
  mount();
});
afterEach(() => {
  view.destroy();
  host.remove();
  vi.useRealTimers();
});

describe("ghost-text completions (spec: ai-inline-completion › Ghost-text completions)", () => {
  it("asks only after typing pauses, with the text around the cursor", async () => {
    type("o");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 10);
    expect(calls).toHaveLength(0);
    await pause();
    expect(calls).toHaveLength(1);
    expect(calls[0].prefix).toBe("SELECT * FROM orders o WHERE o");
    expect(calls[0].suffix).toBe("");
  });

  it("shows the suggestion dim after the cursor with a hint naming the provider", async () => {
    type("o");
    await pause();
    await answer([".status = 'shipped'"], "Copilot");
    expect(currentGhost(view.state)).toBe(".status = 'shipped'");
    const ghost = host.querySelector(".cm-ghostText");
    expect(ghost?.textContent).toBe(".status = 'shipped'");
    expect(host.querySelector(".cm-ghostHint")?.textContent).toContain(
      "Tab accept · ⌥] next · Copilot",
    );
    expect(host.querySelector(".cm-ghost")?.getAttribute("aria-hidden")).toBe("true");
  });

  /** (spec: ai-inline-completion › Accept a suggestion) */
  it("Tab inserts the whole suggestion and leaves the cursor at its end", async () => {
    type("o");
    await pause();
    await answer([".status = 'shipped'"]);
    expect(key("Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT * FROM orders o WHERE o.status = 'shipped'");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(currentGhost(view.state)).toBeNull();
    await pause();
    expect(calls).toHaveLength(1); // accepting doesn't ask again
  });

  it("Tab does nothing special when there is no suggestion", () => {
    expect(key("Tab")).toBe(false);
  });

  /** (spec: ai-inline-completion › Typing through) */
  it("keeps the suggestion, shrunk, while the user types what it says", async () => {
    type("o");
    await pause();
    await answer([".status = 'shipped'"]);
    type(".sta");
    expect(currentGhost(view.state)).toBe("tus = 'shipped'");
    await pause();
    expect(calls).toHaveLength(1); // not re-requested
    key("Tab");
    expect(view.state.doc.toString().endsWith("o.status = 'shipped'")).toBe(true);
  });

  it("drops the suggestion and asks again when the user types something else", async () => {
    type("o");
    await pause();
    await answer([".status = 'shipped'"]);
    type("x");
    expect(currentGhost(view.state)).toBeNull();
    await pause();
    expect(calls).toHaveLength(2);
  });

  it("Esc dismisses the suggestion; moving the cursor does too", async () => {
    type("o");
    await pause();
    await answer(["abc"]);
    expect(key("Escape")).toBe(true);
    expect(currentGhost(view.state)).toBeNull();
    expect(key("Escape")).toBe(false);

    type("p");
    await pause();
    await answer(["def"]);
    view.dispatch({ selection: { anchor: 0 } });
    expect(currentGhost(view.state)).toBeNull();
  });

  it("Mod+Right accepts the next word only", async () => {
    type("o");
    await pause();
    await answer([".status = 'shipped'"]);
    expect(key("ArrowRight", { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString().endsWith("WHERE o.status")).toBe(true);
    expect(currentGhost(view.state)).toBe(" = 'shipped'");
  });

  it("Alt+] and Alt+[ cycle through the alternatives", async () => {
    type("o");
    await pause();
    await answer(["one", "two", "three"]);
    expect(currentGhost(view.state)).toBe("one");
    expect(key("]", { altKey: true })).toBe(true);
    expect(currentGhost(view.state)).toBe("two");
    key("]", { altKey: true });
    key("]", { altKey: true });
    expect(currentGhost(view.state)).toBe("one"); // wraps
    key("[", { altKey: true });
    expect(currentGhost(view.state)).toBe("three");
    expect(host.querySelector(".cm-ghostHint")?.textContent).toContain("(3/3)");
  });

  it("Alt+] is not taken when there is only one suggestion", async () => {
    type("o");
    await pause();
    await answer(["only"]);
    expect(key("]", { altKey: true })).toBe(false);
  });

  /** (spec: ai-inline-completion › Popup open) */
  it("leaves Tab to the schema popup when it is open", async () => {
    type("o");
    await pause();
    await answer(["abc"]);
    popup = true;
    expect(key("Tab")).toBe(false);
    expect(view.state.doc.toString().endsWith("o")).toBe(true);
  });

  it("doesn't ask while the popup is open", async () => {
    popup = true;
    type("o");
    await pause();
    expect(calls).toHaveLength(0);
  });

  /** (spec: ai-inline-completion › Cancelled on typing) */
  it("cancels the request in flight when the user keeps typing, and asks once more after the pause", async () => {
    type("o");
    await pause();
    expect(calls).toHaveLength(1);
    type(".");
    expect(calls[0].signal.aborted).toBe(true);
    type("s");
    await pause();
    expect(calls).toHaveLength(2);
    expect(calls[1].prefix.endsWith("o.s")).toBe(true);
    // A late answer to the first request is ignored.
    calls[0].resolve({ suggestions: ["stale"], provider: "Copilot" });
    await vi.advanceTimersByTimeAsync(0);
    expect(currentGhost(view.state)).toBeNull();
  });

  it("doesn't ask when completions are off", async () => {
    enabled = false;
    type("o");
    await pause();
    expect(calls).toHaveLength(0);
  });

  it("doesn't ask for a document over 1 MB", async () => {
    view.destroy();
    host.remove();
    mount("x".repeat(1_000_001));
    type("o");
    await pause();
    expect(calls).toHaveLength(0);
  });

  it("doesn't ask while text is selected", async () => {
    type("o");
    view.dispatch({ selection: { anchor: 0, head: 6 } });
    await pause();
    expect(calls).toHaveLength(0);
  });

  it("shows nothing for an empty answer", async () => {
    type("o");
    await pause();
    await answer([]);
    expect(currentGhost(view.state)).toBeNull();
  });
});

describe("firstWord", () => {
  it("takes the leading whitespace and the next word", () => {
    expect(firstWord(" = 'x' AND y")).toBe(" =");
    expect(firstWord("status")).toBe("status");
    expect(firstWord("")).toBe("");
  });
});

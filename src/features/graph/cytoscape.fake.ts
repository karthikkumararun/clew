/**
 * A stand-in for `cytoscape` in jsdom tests (which have no canvas): it records the elements it is
 * given and answers the few calls `GraphCanvas` makes. Use with
 * `vi.mock("cytoscape", () => import("./cytoscape.fake"))`.
 */
interface Def {
  group?: string;
  data: Record<string, unknown>;
}

type Handler = (e: { target: unknown }) => void;

export class FakeCy {
  readonly els = new Map<string, Def>();
  readonly handlers: { event: string; selector?: string; fn: Handler }[] = [];
  readonly layouts: unknown[] = [];
  selected: string | null = null;
  destroyed = false;

  on(event: string, a: string | Handler, b?: Handler) {
    this.handlers.push(
      typeof a === "string" ? { event, selector: a, fn: b as Handler } : { event, fn: a },
    );
  }
  add(defs: Def[]) {
    for (const d of defs) this.els.set(String(d.data.id), d);
  }
  elements(selector?: string) {
    return {
      remove: () => this.els.clear(),
      forEach: (fn: (el: ReturnType<FakeCy["getElementById"]>) => void) =>
        [...this.els.keys()].forEach((id) => fn(this.getElementById(id))),
      unselect: () => {
        if (selector === ":selected") this.selected = null;
      },
    };
  }
  getElementById(id: string) {
    const def = this.els.get(id);
    return {
      empty: () => !def,
      id: () => id,
      data: (k?: string, v?: unknown) => {
        if (def && k && v !== undefined) def.data[k] = v;
        return def && k ? def.data[k] : undefined;
      },
      select: () => {
        this.selected = id;
      },
      remove: () => {
        this.els.delete(id);
      },
      addClass: () => undefined,
      removeClass: () => undefined,
      position: () => ({ x: 0, y: 0 }),
    };
  }
  layout(options: unknown) {
    this.layouts.push(options);
    return { run: () => undefined, one: () => undefined };
  }
  zoom() {
    return 1;
  }
  width() {
    return 800;
  }
  height() {
    return 600;
  }
  resize() {}
  fit() {}
  destroy() {
    this.destroyed = true;
  }

  nodes(): Def[] {
    return [...this.els.values()].filter((d) => d.group === "nodes");
  }
  edges(): Def[] {
    return [...this.els.values()].filter((d) => d.group === "edges");
  }
  /** Fire a Cytoscape event as the canvas would. */
  emit(event: string, target: unknown, selector?: string) {
    this.handlers
      .filter((h) => h.event === event && (h.selector ?? undefined) === selector)
      .forEach((h) => h.fn({ target }));
  }
}

export const instances: FakeCy[] = [];

const cytoscape = Object.assign(
  () => {
    const cy = new FakeCy();
    instances.push(cy);
    return cy;
  },
  { use: () => undefined },
);

export default cytoscape;

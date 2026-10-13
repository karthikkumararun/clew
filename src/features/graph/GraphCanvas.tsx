/**
 * The Graph view on Cytoscape.js with the fcose layout (spec: graph-browser › Graph view).
 * Cytoscape draws on a canvas, so a visually hidden, focusable list mirrors the drawn elements
 * for keyboard and screen-reader users; in end-to-end builds the same list carries `data-testid`s.
 */
import cytoscape from "cytoscape";
import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useEffect, useMemo, useRef } from "react";
import { IconButton } from "../../components/Button";
import { Fit, Minus, Plus } from "../../components/icons";
import { MIRROR_ENABLED } from "./mirror";
import { cssOfLabel, LABEL_TOKENS, resolveToken } from "./palette";
import type { BuiltGraph } from "./graphModel";
import type { GraphNode, GraphRel } from "./types";
import styles from "./Graph.module.css";

let registered = false;
function registerLayout() {
  if (registered) return;
  registered = true;
  cytoscape.use(fcose);
}

const DOUBLE_TAP_MS = 350;
const ZOOM_STEP = 1.25;
/** Relationships listed for assistive tech at most; the canvas still draws them all. */
const MIRROR_EDGES = 600;

function stylesheet(): StylesheetJson {
  const onAccent = resolveToken("--on-accent");
  const accent = resolveToken("--accent");
  const edge = resolveToken("--text-gutter");
  const edgeText = resolveToken("--text-dim");
  const ground = resolveToken("--bg-app");
  const ui = resolveToken("--font-ui");
  const mono = resolveToken("--font-mono");
  const rules: StylesheetJson = [
    {
      selector: "node",
      style: {
        label: "data(caption)",
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "ellipsis",
        "text-max-width": "46px",
        "font-size": 9.5,
        "font-weight": 600,
        "font-family": ui,
        color: onAccent,
        width: 52,
        height: 52,
        "border-width": 0,
        "overlay-opacity": 0,
      },
    },
    ...LABEL_TOKENS.map((token) => ({
      selector: `node[token = "${token}"]`,
      style: { "background-color": resolveToken(token) },
    })),
    {
      selector: "node:selected, node.focused",
      style: { "border-width": 3, "border-color": accent },
    },
    { selector: "node.pinned", style: { "border-width": 2, "border-style": "dashed" } },
    {
      selector: "edge",
      style: {
        width: 1.4,
        "line-color": edge,
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "target-arrow-color": edge,
        "arrow-scale": 0.9,
        label: "data(type)",
        "font-size": 8.5,
        "font-family": mono,
        color: edgeText,
        "text-rotation": "autorotate",
        "text-background-color": ground,
        "text-background-opacity": 0.85,
        "text-background-padding": "2px",
        "overlay-opacity": 0,
      },
    },
    {
      selector: "edge:selected, edge.focused",
      style: { "line-color": accent, "target-arrow-color": accent, width: 2.4 },
    },
  ];
  return rules;
}

export interface GraphCanvasProps {
  built: BuiltGraph;
  nodes: readonly GraphNode[];
  relationships: readonly GraphRel[];
  /** A new run: lay the graph out afresh instead of keeping positions. */
  epoch: number;
  selectedId: string | null;
  /** Elements the notice below the toolbar talks about. */
  capNotice: { shown: number; total: number } | null;
  hiddenCount: number;
  onSelect: (selection: { kind: "node" | "relationship"; id: string } | null) => void;
  onExpand: (id: string) => void;
  onShowAll: () => void;
  onUseTable: () => void;
  onUnhide: () => void;
}

export function GraphCanvas(props: GraphCanvasProps) {
  const { built } = props;
  const host = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const pinned = useRef(new Set<string>());
  const lastEpoch = useRef<number | null>(null);

  // One Cytoscape instance per mounted view.
  useEffect(() => {
    registerLayout();
    const cy = cytoscape({
      container: host.current,
      elements: [],
      style: stylesheet(),
      minZoom: 0.1,
      maxZoom: 4,
      wheelSensitivity: 0.3,
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;
    let tapped: { id: string; at: number } | null = null;
    cy.on("tap", "node", (e) => {
      const id = e.target.id() as string;
      const now = Date.now();
      if (tapped && tapped.id === id && now - tapped.at < DOUBLE_TAP_MS) {
        tapped = null;
        latest.current.onExpand(id);
        return;
      }
      tapped = { id, at: now };
      latest.current.onSelect({ kind: "node", id });
    });
    cy.on("tap", "edge", (e) =>
      latest.current.onSelect({ kind: "relationship", id: e.target.id() }),
    );
    cy.on("tap", (e) => {
      if (e.target === cy) latest.current.onSelect(null);
    });
    // dragging a node pins it where it was dropped
    cy.on("dragfree", "node", (e) => {
      pinned.current.add(e.target.id());
      e.target.addClass("pinned");
    });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => cy.resize());
    if (host.current) observer?.observe(host.current);
    return () => {
      observer?.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Keep the drawn elements equal to the model: all afresh for a new run, a diff otherwise.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const fresh = lastEpoch.current !== props.epoch;
    lastEpoch.current = props.epoch;
    if (fresh) {
      pinned.current.clear();
      cy.elements().remove();
      cy.add(built.elements);
      layout(cy, true, []);
      return;
    }
    const wanted = new Map(built.elements.map((e) => [e.data.id as string, e]));
    cy.elements().forEach((el) => {
      if (!wanted.has(el.id())) el.remove();
    });
    const added: ElementDefinition[] = [];
    for (const [id, def] of wanted) {
      const existing = cy.getElementById(id);
      if (existing.empty()) added.push(placed(cy, def, built.elements));
      else if (def.group === "nodes") existing.data("caption", def.data.caption);
    }
    if (added.length > 0) {
      cy.add(added);
      layout(cy, false, [...pinned.current]);
    }
  }, [built, props.epoch]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements(":selected").unselect();
    if (props.selectedId) cy.getElementById(props.selectedId).select();
  }, [props.selectedId, built]);

  const zoomBy = (factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({
      level: cy.zoom() * factor,
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
    });
  };

  const focusOn = (id: string, on: boolean) => {
    const el = cyRef.current?.getElementById(id);
    if (el && !el.empty()) {
      if (on) el.addClass("focused");
      else el.removeClass("focused");
    }
  };

  const nodeById = useMemo(() => new Map(props.nodes.map((n) => [n.elementId, n])), [props.nodes]);
  const shownEdges = useMemo(() => {
    const ids = new Set(built.elements.filter((e) => e.group === "edges").map((e) => e.data.id));
    return props.relationships.filter((r) => ids.has(r.elementId)).slice(0, MIRROR_EDGES);
  }, [built, props.relationships]);

  const summary = `Graph of ${built.shown.length} ${built.shown.length === 1 ? "node" : "nodes"} and ${built.edges} ${built.edges === 1 ? "relationship" : "relationships"}`;

  return (
    <div className={styles.canvas} data-testid={MIRROR_ENABLED ? "graph-canvas" : undefined}>
      <div ref={host} role="img" aria-label={summary} style={{ position: "absolute", inset: 0 }} />
      <ul
        className={styles.elementList}
        aria-label="Graph elements"
        data-testid={MIRROR_ENABLED ? "graph-mirror" : undefined}
        data-node-count={MIRROR_ENABLED ? built.shown.length : undefined}
        data-edge-count={MIRROR_ENABLED ? built.edges : undefined}
      >
        {built.shown.map((id) => {
          const node = nodeById.get(id);
          const caption = built.elements.find((e) => e.data.id === id)?.data.caption as string;
          return (
            <li key={id}>
              <button
                type="button"
                aria-pressed={props.selectedId === id}
                data-testid={MIRROR_ENABLED ? "graph-node" : undefined}
                data-id={MIRROR_ENABLED ? id : undefined}
                data-labels={MIRROR_ENABLED ? (node?.labels ?? []).join(",") : undefined}
                data-caption={MIRROR_ENABLED ? caption : undefined}
                onFocus={() => focusOn(id, true)}
                onBlur={() => focusOn(id, false)}
                onClick={() => props.onSelect({ kind: "node", id })}
              >
                {`${(node?.labels ?? []).join(", ") || "Node"}: ${caption}`}
              </button>
            </li>
          );
        })}
        {shownEdges.map((r) => (
          <li key={r.elementId}>
            <button
              type="button"
              aria-pressed={props.selectedId === r.elementId}
              data-testid={MIRROR_ENABLED ? "graph-edge" : undefined}
              data-id={MIRROR_ENABLED ? r.elementId : undefined}
              data-type={MIRROR_ENABLED ? r.relType : undefined}
              data-source={MIRROR_ENABLED ? r.startId : undefined}
              data-target={MIRROR_ENABLED ? r.endId : undefined}
              onFocus={() => focusOn(r.elementId, true)}
              onBlur={() => focusOn(r.elementId, false)}
              onClick={() => props.onSelect({ kind: "relationship", id: r.elementId })}
            >
              {`${r.relType} from ${nodeCaption(built, r.startId)} to ${nodeCaption(built, r.endId)}`}
            </button>
          </li>
        ))}
      </ul>

      {props.capNotice ? (
        <div className={`${styles.overlay} ${styles.capNotice}`} role="status">
          <span>
            Showing {props.capNotice.shown.toLocaleString()} of{" "}
            {props.capNotice.total.toLocaleString()} nodes —{" "}
          </span>
          <button type="button" className={styles.linkButton} onClick={props.onShowAll}>
            Show all
          </button>
          <span>/</span>
          <button type="button" className={styles.linkButton} onClick={props.onUseTable}>
            Use Table view
          </button>
        </div>
      ) : null}
      {props.hiddenCount > 0 ? (
        <div className={`${styles.overlay} ${styles.hiddenNote}`}>
          <span>
            {props.hiddenCount} hidden {props.hiddenCount === 1 ? "node" : "nodes"}
          </span>
          <button type="button" className={styles.linkButton} onClick={props.onUnhide}>
            Show hidden
          </button>
        </div>
      ) : null}

      <div className={`${styles.overlay} ${styles.legend}`} aria-label="Legend">
        {built.labels.map((l) => (
          <span
            key={l.name}
            className={`${styles.label} ${styles.labelSmall}`}
            style={{ background: cssOfLabel(l.name) }}
          >
            {l.name || "No label"} {l.count}
          </span>
        ))}
        {built.types.map((t) => (
          <span key={t.name} className={styles.type}>
            {t.name} {t.count}
          </span>
        ))}
      </div>
      <div className={`${styles.overlay} ${styles.zoom}`}>
        <IconButton aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
          <Plus size={14} />
        </IconButton>
        <IconButton aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          <Minus size={14} />
        </IconButton>
        <IconButton aria-label="Fit to screen" onClick={() => cyRef.current?.fit(undefined, 30)}>
          <Fit size={14} />
        </IconButton>
      </div>
    </div>
  );
}

function nodeCaption(built: BuiltGraph, id: string): string {
  return (built.elements.find((e) => e.data.id === id)?.data.caption as string) ?? id;
}

/** A new node starts next to a neighbour already drawn, so expansion grows out of its node. */
function placed(cy: Core, def: ElementDefinition, all: ElementDefinition[]): ElementDefinition {
  if (def.group !== "nodes") return def;
  const link = all.find(
    (e) =>
      e.group === "edges" &&
      (e.data.source === def.data.id || e.data.target === def.data.id) &&
      !cy.getElementById(e.data.source === def.data.id ? e.data.target : e.data.source).empty(),
  );
  if (!link) return def;
  const otherId = link.data.source === def.data.id ? link.data.target : link.data.source;
  const at = cy.getElementById(otherId).position();
  const jitter = () => (Math.random() - 0.5) * 80;
  return { ...def, position: { x: at.x + jitter(), y: at.y + jitter() } };
}

function layout(cy: Core, full: boolean, pinnedIds: string[]) {
  const fixed = pinnedIds
    .map((id) => cy.getElementById(id))
    .filter((n) => !n.empty())
    .map((n) => ({ nodeId: n.id(), position: n.position() }));
  cy.resize(); // the container may have changed size since Cytoscape last measured it
  const run = cy.layout({
    name: "fcose",
    animate: true,
    animationDuration: 400,
    randomize: full,
    fit: full,
    padding: 30,
    nodeDimensionsIncludeLabels: true,
    quality: "default",
    idealEdgeLength: 130,
    nodeRepulsion: 12000,
    nodeSeparation: 90,
    ...(fixed.length > 0 ? { fixedNodeConstraint: fixed } : {}),
  } as cytoscape.LayoutOptions);
  // a fresh layout ends with the whole graph in view
  if (full) run.one("layoutstop", () => cy.fit(undefined, 30));
  run.run();
}

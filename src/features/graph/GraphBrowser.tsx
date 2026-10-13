import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { DriverBadge, EnvDot } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Menu } from "../../components/Menu";
import { ChevronDown, Play } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { formatShortcut } from "../../lib/platform";
import { useNotices } from "../../stores/noticesStore";
import { useSettings } from "../../stores/settingsStore";
import { Editor } from "../console/editor/Editor";
import { AccessBadge } from "./AccessBadge";
import { cancelGraphTab, patchGraphTab, runGraphTab } from "./commands";
import { cypherCompletion } from "./cypher/completion";
import { parseParams } from "./cypher/params";
import { labelQuery, matchCypher, relTypeQuery } from "./cypherText";
import { GraphCanvas } from "./GraphCanvas";
import { buildGraph, captionOf, hasGraphElements, NODE_CAP } from "./graphModel";
import { Inspector, announcement } from "./Inspector";
import type { InspectedElement } from "./Inspector";
import { JsonView, PlanView, TableView } from "./ResultViews";
import { getGraphRuntime } from "./runtime";
import { SchemaSidebar } from "./SchemaSidebar";
import { GRAPH_VIEWS } from "./state";
import type { GraphTab, GraphView } from "./state";
import styles from "./Graph.module.css";

const VIEW_LABEL: Record<GraphView, string> = {
  graph: "Graph",
  table: "Table",
  json: "JSON",
  plan: "Plan",
};

const NO_GRAPH = "No nodes or relationships in this result";

/** The graph console tab (spec: graph-browser › Graph console tab). */
export function GraphBrowser({ tab }: { tab: GraphTab }) {
  const s = tab.state;
  const connection = useConnections((c) => c.file.connections.find((x) => x.id === s.connectionId));
  const runtime = useMemo(() => getGraphRuntime(tab.id, s.connectionId), [tab.id, s.connectionId]);
  const fontSize = useSettings((x) => x.settings.editorFontSize);

  const readOnly = useStore(runtime.store, (r) => r.readOnly);
  const running = useStore(runtime.store, (r) => r.running);
  const error = useStore(runtime.store, (r) => r.error);
  const result = useStore(runtime.store, (r) => r.result);
  const mode = useStore(runtime.store, (r) => r.mode);
  const nodes = useStore(runtime.store, (r) => r.nodes);
  const relationships = useStore(runtime.store, (r) => r.relationships);
  const hidden = useStore(runtime.store, (r) => r.hidden);
  const showAll = useStore(runtime.store, (r) => r.showAll);
  const epoch = useStore(runtime.store, (r) => r.epoch);
  const selection = useStore(runtime.store, (r) => r.selection);
  const neighbours = useStore(runtime.store, (r) => r.neighbours);
  const expanding = useStore(runtime.store, (r) => r.expanding);
  const captions = useStore(runtime.store, (r) => r.captions);
  const schema = useStore(runtime.store, (r) => r.schema);
  const schemaLoading = useStore(runtime.store, (r) => r.schemaLoading);
  const schemaError = useStore(runtime.store, (r) => r.schemaError);
  const databases = useStore(runtime.store, (r) => r.databases);
  const paramsError = useStore(runtime.store, (r) => r.paramsError);
  const paramsFocus = useStore(runtime.store, (r) => r.paramsFocus);
  const actionError = useStore(runtime.store, (r) => r.actionError);
  const loadingMore = useStore(runtime.store, (r) => r.loadingMore);

  const [dbMenu, setDbMenu] = useState(false);
  const params = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(s);
  latest.current = s;

  // Schema-aware completion reads the live schema and the Parameters panel on every request.
  const completion = useMemo(
    () =>
      cypherCompletion({
        schema: () => runtime.store.getState().schema,
        params: () => {
          const parsed = parseParams(latest.current.params);
          return parsed.ok ? Object.keys(parsed.value) : [];
        },
      }),
    [runtime],
  );

  const database =
    s.database ||
    (connection?.settings.kind === "neo4j" ? connection.settings.database : "") ||
    "neo4j";

  // Open the session and load the schema and database list once.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await runtime.ensureSession(latest.current.database);
      } catch {
        /* the schema load below reports the problem */
      }
      if (!live) return;
      void runtime.loadSchema(latest.current.database);
      void runtime.loadDatabases();
    })();
    return () => {
      live = false;
    };
  }, [runtime]);

  // Opened from the explorer with a query to run.
  useEffect(() => {
    if (!latest.current.autoRun) return;
    patchGraphTab(tab.id, { autoRun: false });
    void runGraphTab(tab.id, "run", latest.current.text.trim());
  }, [tab.id]);

  // A missing parameter opens the Parameters panel and focuses it.
  useEffect(() => {
    if (paramsFocus === 0) return;
    if (!latest.current.paramsOpen) patchGraphTab(tab.id, { paramsOpen: true });
    const id = setTimeout(() => params.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [paramsFocus, tab.id]);

  const built = useMemo(
    () =>
      buildGraph(nodes, relationships, {
        cap: showAll ? null : NODE_CAP,
        hidden,
        captions,
      }),
    [nodes, relationships, hidden, showAll, captions],
  );

  if (!connection) {
    return (
      <div className={styles.missing} role="alert">
        The connection for this console no longer exists.
      </div>
    );
  }

  const hasGraph = result ? hasGraphElements(result) : true;
  const view: GraphView = s.view === "graph" && !hasGraph ? "table" : s.view;
  const profiled = mode === "profile";

  const selected: InspectedElement | null = (() => {
    if (!selection) return null;
    if (selection.kind === "node") {
      const node = nodes.find((n) => n.elementId === selection.id);
      return node ? { kind: "node", node } : null;
    }
    const rel = relationships.find((r) => r.elementId === selection.id);
    return rel ? { kind: "relationship", rel } : null;
  })();

  const select = (sel: { kind: "node" | "relationship"; id: string } | null) => {
    runtime.select(sel);
    if (sel && !s.inspectorOpen) patchGraphTab(tab.id, { inspectorOpen: true });
  };

  const run = (m: "run" | "profile") => void runGraphTab(tab.id, m);

  const insertAndRun = (query: string) => {
    const current = latest.current.text;
    const next = current.trim() === "" ? query : `${current.replace(/\s+$/, "")}\n\n${query}`;
    patchGraphTab(tab.id, { text: next });
    void runGraphTab(tab.id, "run", query);
  };

  const copyMatch = async (element: Parameters<typeof matchCypher>[0]) => {
    try {
      await navigator.clipboard.writeText(matchCypher(element));
      useNotices.getState().push("Copied the MATCH query");
    } catch {
      useNotices.getState().push("Couldn't copy to the clipboard");
    }
  };

  const summary = (() => {
    if (!result) return "";
    if (mode !== "run" && !hasGraph) return `${result.summary.elapsedMs} ms`;
    if (hasGraphElements(result)) {
      return `${nodes.length} ${nodes.length === 1 ? "node" : "nodes"} · ${relationships.length} ${
        relationships.length === 1 ? "relationship" : "relationships"
      } · ${result.summary.elapsedMs} ms`;
    }
    const n = result.records.length;
    return `${n.toLocaleString()}${result.hasMore ? "+" : ""} ${n === 1 ? "record" : "records"} · ${result.summary.elapsedMs} ms`;
  })();

  const announce = selected
    ? announcement(
        selected,
        selected.kind === "node" ? captionOf(selected.node, captions) : selected.rel.relType,
      )
    : "";

  const stage = (() => {
    if (error) {
      return (
        <div role="alert" className={styles.errorBox}>
          {error}
        </div>
      );
    }
    if (!result) {
      return (
        <div className={styles.empty}>
          {running
            ? "Running…"
            : "Run a Cypher query to see its graph. Click a label on the left to start."}
        </div>
      );
    }
    switch (view) {
      case "graph":
        return (
          <GraphCanvas
            built={built}
            nodes={nodes}
            relationships={relationships}
            epoch={epoch}
            selectedId={selection?.id ?? null}
            capNotice={
              built.shown.length < built.total
                ? { shown: built.shown.length, total: built.total }
                : null
            }
            hiddenCount={hidden.size}
            onSelect={select}
            onExpand={(id) => void runtime.expand(id)}
            onShowAll={() => runtime.setShowAll(true)}
            onUseTable={() => patchGraphTab(tab.id, { view: "table" })}
            onUnhide={() => runtime.unhideAll()}
          />
        );
      case "table":
        return (
          <TableView
            result={result}
            captions={captions}
            loadingMore={loadingMore}
            onInspect={(kind, id) => select({ kind, id })}
            onLoadMore={() => void runtime.loadMore()}
          />
        );
      case "json":
        return <JsonView result={result} />;
      case "plan":
        return <PlanView plan={result.plan} profiled={profiled} />;
    }
  })();

  return (
    <div className={styles.browser} data-shortcut-scope="editor">
      <header className={styles.header}>
        <nav aria-label="Breadcrumb" className={styles.crumbs}>
          <EnvDot env={BADGE_ENV[connection.environment]} size={8} />
          <DriverBadge driver="neo4j" />
          <span>{connection.name}</span>
          <span aria-hidden="true">›</span>
          <span className={styles.dbWrap}>
            <button
              type="button"
              className={styles.crumbButton}
              aria-label={`Database: ${database}`}
              aria-haspopup="menu"
              aria-expanded={dbMenu}
              onClick={() => setDbMenu((o) => !o)}
            >
              {database}
              <ChevronDown size={11} />
            </button>
            {dbMenu ? (
              <>
                <div
                  className={styles.scrim}
                  onMouseDown={() => setDbMenu(false)}
                  aria-hidden="true"
                />
                <div className={styles.dbMenu}>
                  <Menu
                    aria-label="Databases"
                    items={(databases ?? [database]).map((d) => ({
                      id: d,
                      label: d,
                      hint: d === database ? "current" : undefined,
                    }))}
                    onClose={() => setDbMenu(false)}
                    onSelect={(d) => {
                      setDbMenu(false);
                      if (d === database) return;
                      patchGraphTab(tab.id, { database: d });
                      void runtime.switchDatabase(d);
                    }}
                  />
                </div>
              </>
            ) : null}
          </span>
        </nav>
        {running ? (
          <Button variant="toolbar" onClick={() => void cancelGraphTab(tab.id)}>
            <span className={styles.spinner} aria-hidden="true" />
            Cancel
          </Button>
        ) : (
          <Button variant="primary" onClick={() => run("run")}>
            <Play size={12} />
            Run
            <span className={styles.kbd}>{formatShortcut("Mod+Enter")}</span>
          </Button>
        )}
        <Button variant="toolbar" disabled={running} onClick={() => run("profile")}>
          Profile
        </Button>
        <AccessBadge
          connectionName={connection.name}
          environment={connection.environment}
          readOnly={readOnly}
          onChange={(ro) => void runtime.setReadOnly(ro)}
        />
        <div className={styles.grow} />
        <Button
          variant="ghost"
          aria-pressed={s.paramsOpen}
          onClick={() => patchGraphTab(tab.id, { paramsOpen: !s.paramsOpen })}
        >
          Parameters
        </Button>
      </header>

      <div className={styles.body}>
        <SchemaSidebar
          schema={schema}
          loading={schemaLoading}
          error={schemaError}
          onLabel={(label) => insertAndRun(labelQuery(label))}
          onType={(type) => insertAndRun(relTypeQuery(type))}
        />

        <main className={styles.main}>
          <section className={styles.editorPane} aria-label="Cypher editor">
            <Editor
              tabId={tab.id}
              driver="neo4j"
              value={s.text}
              fontSize={fontSize}
              onChange={(text) => patchGraphTab(tab.id, { text })}
              extensions={completion}
              onRunStatement={(r) => void runGraphTab(tab.id, "run", r.text)}
            />
          </section>
          {s.paramsOpen ? (
            <section className={styles.paramsPane} aria-label="Parameters">
              <div className={styles.paramsHead}>Parameters (JSON)</div>
              <textarea
                ref={params}
                className={styles.paramsInput}
                aria-label="Query parameters (JSON)"
                aria-invalid={paramsError !== null}
                spellCheck={false}
                value={s.params}
                placeholder='{"name": "Ada Lovelace"}'
                onChange={(e) => {
                  patchGraphTab(tab.id, { params: e.target.value });
                  if (paramsError) runtime.store.setState({ paramsError: null });
                }}
              />
              {paramsError ? (
                <div role="alert" className={styles.paramsError}>
                  {paramsError}
                </div>
              ) : null}
            </section>
          ) : null}

          <div className={styles.resultBar}>
            <div role="tablist" aria-label="Result view" className={styles.views}>
              {GRAPH_VIEWS.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  className={styles.view}
                  disabled={v === "graph" && !hasGraph}
                  title={v === "graph" && !hasGraph ? NO_GRAPH : undefined}
                  onClick={() => patchGraphTab(tab.id, { view: v })}
                >
                  {VIEW_LABEL[v]}
                </button>
              ))}
            </div>
            {!hasGraph ? <span className={styles.summary}>{NO_GRAPH}</span> : null}
            <div className={styles.grow} />
            <span className={styles.summary} aria-live="polite">
              {summary}
            </span>
          </div>
          <div className={styles.stage}>
            {stage}
            {actionError && !selected ? (
              <div role="alert" className={styles.errorBox}>
                {actionError}
              </div>
            ) : null}
          </div>
        </main>

        {s.inspectorOpen ? (
          <Inspector
            element={selected}
            neighbours={selection ? neighbours[selection.id] : undefined}
            writable={!readOnly}
            captions={captions}
            expanding={expanding !== null}
            error={actionError}
            onClose={() => {
              runtime.select(null);
              patchGraphTab(tab.id, { inspectorOpen: false });
            }}
            onExpand={(id) => void runtime.expand(id)}
            onHide={(id) => runtime.hide(id)}
            onCopy={(el) => void copyMatch(el)}
            onSave={(kind, id, changes) => runtime.updateProperties(kind, id, changes)}
            onCaption={(label, key) => runtime.setCaption(label, key)}
          />
        ) : null}
      </div>
      <div role="status" className={styles.srOnly}>
        {announce}
      </div>
    </div>
  );
}

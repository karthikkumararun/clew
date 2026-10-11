import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useStore } from "zustand";
import { Button, IconButton } from "../../components/Button";
import { EnvDot } from "../../components/Badge";
import { ChevronDown, ChevronRight, Download, Plus, Terminal } from "../../components/icons";
import { Menu } from "../../components/Menu";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { formatShortcut } from "../../lib/platform";
import { runCommand } from "../../shell/registry/commands";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { askChoice } from "../console/prompts";
import { ColumnarStore } from "../grid/source";
import { ResultGrid } from "../grid/ResultGrid";
import { ReadOnlyBadge } from "../safety/ReadOnlyBadge";
import { exportPickPath } from "./api";
import type { ExportFormat } from "./api";
import { setCollectionActions } from "./actions";
import { JsonEditDialog, ValueEditDialog } from "./Dialogs";
import { childrenOf, describe, editText, getAt, idOf, toShell } from "./ejson";
import type { EJson } from "./ejson";
import { IndexesPane, SchemaPane } from "./Panes";
import { getCollectionRuntime, messageOf } from "./runtime";
import type { CollectionRuntime } from "./runtime";
import type { CollectionPane, CollectionTab, CollectionTabState, DocView } from "./state";
import { docsToTable } from "./tableModel";
import { flattenDocs } from "./treeModel";
import type { TreeRow } from "./treeModel";
import { TreeView } from "./TreeView";
import styles from "./Documents.module.css";

const PANES: { id: CollectionPane; label: string }[] = [
  { id: "documents", label: "Documents" },
  { id: "schema", label: "Inferred schema" },
  { id: "indexes", label: "Indexes" },
];

const VIEWS: { id: DocView; label: string }[] = [
  { id: "tree", label: "Tree" },
  { id: "table", label: "Table" },
  { id: "json", label: "JSON" },
];

const EXPORTS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: "json", label: "JSON", ext: "json" },
  { id: "jsonl", label: "JSON Lines", ext: "jsonl" },
  { id: "csv", label: "CSV", ext: "csv" },
];

const patchTab = (id: string, patch: Partial<CollectionTabState>) =>
  useWorkspace.getState().updateTabState<Partial<CollectionTabState>>(id, patch);

const docKey = (doc: EJson) => JSON.stringify(idOf(doc) ?? null);

type Dialog =
  | { kind: "value"; docIndex: number; path: string[] }
  | { kind: "field"; docIndex: number; parent: string[] }
  | { kind: "document"; docIndex: number }
  | { kind: "insert" };

interface RowMenu {
  row: TreeRow;
  x: number;
  y: number;
}

export function CollectionBrowser({ tab }: { tab: CollectionTab }) {
  const s = tab.state;
  const connection = useConnections((c) => c.file.connections.find((x) => x.id === s.connectionId));
  const runtime = useMemo(
    () => getCollectionRuntime(tab.id, s.connectionId, s.database, s.collection),
    [tab.id, s.connectionId, s.database, s.collection],
  );
  const docs = useStore(runtime.store, (r) => r.docs);
  const loading = useStore(runtime.store, (r) => r.loading);
  const loaded = useStore(runtime.store, (r) => r.loaded);
  const error = useStore(runtime.store, (r) => r.error);
  const hasMore = useStore(runtime.store, (r) => r.hasMore);
  const fetching = useStore(runtime.store, (r) => r.fetching);
  const matched = useStore(runtime.store, (r) => r.matched);
  const elapsedMs = useStore(runtime.store, (r) => r.elapsedMs);
  const plan = useStore(runtime.store, (r) => r.plan);
  const readOnly = useStore(runtime.store, (r) => r.readOnly);
  const saving = useStore(runtime.store, (r) => r.saving);
  const saveError = useStore(runtime.store, (r) => r.saveError);
  // re-render when staged edits change
  const pendingVersion = useStore(runtime.store, (r) => r.pendingVersion);

  const [draft, setDraft] = useState({
    filter: s.filter,
    project: s.project,
    sort: s.sort,
    limit: s.limit === 0 ? "" : String(s.limit),
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [exportMenu, setExportMenu] = useState(false);

  const applied = useMemo(
    () => ({ filter: s.filter, project: s.project, sort: s.sort, limit: s.limit }),
    [s.filter, s.project, s.sort, s.limit],
  );

  // Show the first page when the tab opens (or comes back with a different query).
  useEffect(() => {
    void runtime.findIfNeeded(applied);
  }, [runtime, applied]);

  useEffect(() => {
    if (s.pane === "schema" && !runtime.store.getState().schema) void runtime.loadSchema();
    if (s.pane === "indexes" && !runtime.store.getState().indexes) void runtime.loadIndexes();
  }, [runtime, s.pane]);

  const find = useCallback(() => {
    const limit = draft.limit.trim() === "" ? 0 : Math.max(0, Math.floor(Number(draft.limit)) || 0);
    const next = {
      filter: draft.filter,
      project: draft.project,
      sort: draft.sort,
      limit,
    };
    const run = async () => {
      if (runtime.pendingCount > 0 && !(await confirmDiscard(runtime))) return;
      patchTab(tab.id, next);
      // same query again must still run
      if (JSON.stringify(next) === JSON.stringify(applied)) await runtime.find(next);
    };
    void run();
  }, [draft, runtime, tab.id, applied]);

  const save = useCallback(() => void runtime.save(), [runtime]);

  useEffect(() => {
    setCollectionActions(tab.id, { find, save });
    return () => setCollectionActions(tab.id, null);
  }, [tab.id, find, save]);

  const effectiveDocs = useMemo(
    () => docs.map((d) => runtime.effective(d)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs, pendingVersion, runtime],
  );

  const rows = useMemo(
    () => flattenDocs(effectiveDocs, expanded, docKey),
    [effectiveDocs, expanded],
  );

  const say = (m: string) => useNotices.getState().push(m);

  const toggle = (row: TreeRow) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });

  const expandAll = () => {
    const keys = new Set<string>();
    const walk = (doc: EJson, v: EJson, path: string[]) => {
      if (!describe(v).container) return;
      keys.add(`${docKey(doc)}|${JSON.stringify(path)}`);
      for (const [k, c] of childrenOf(v)) walk(doc, c, [...path, k]);
    };
    for (const d of effectiveDocs) walk(d, d, []);
    setExpanded(keys);
  };

  const original = (docIndex: number) => docs[docIndex];

  const edit = (docIndex: number, path: string[], value: EJson) =>
    runtime.stageSet(original(docIndex), path, value);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say("Copied");
    } catch {
      say("Couldn't copy to the clipboard");
    }
  };

  const deleteDocument = async (docIndex: number) => {
    const doc = original(docIndex);
    const choice = await askChoice({
      title: "Delete this document?",
      body: <p>{describe(idOf(doc) ?? null).display} will be removed from the collection.</p>,
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "delete", label: "Delete", variant: "primary" },
      ],
    });
    if (choice !== "delete") return;
    try {
      await runtime.deleteDocs([doc]);
    } catch (e) {
      say(`Delete failed: ${messageOf(e)}`);
    }
  };

  const doExport = async (f: (typeof EXPORTS)[number]) => {
    setExportMenu(false);
    try {
      const path = await exportPickPath(s.collection, f.ext);
      if (!path) return;
      const n = await runtime.exportTo(path, f.id, applied);
      say(`Exported ${n.toLocaleString()} ${n === 1 ? "document" : "documents"} to ${path}`);
    } catch (e) {
      say(`Export failed: ${messageOf(e)}`);
    }
  };

  const menuItems = (row: TreeRow) => {
    const container = row.described.container;
    return [
      ...(!row.isDoc && !container ? [{ id: "edit", label: "Edit value" }] : []),
      ...(container ? [{ id: "add", label: "Add field" }] : []),
      ...(row.isDoc ? [{ id: "json", label: "Edit document as JSON" }] : []),
      ...(!row.isDoc ? [{ id: "unset", label: "Delete field" }] : []),
      { id: "copy", label: row.isDoc ? "Copy document" : "Copy value" },
      ...(row.isDoc ? [{ id: "delete", label: "Delete document" }] : []),
    ].filter((i) => !(readOnly && ["edit", "add", "json", "unset", "delete"].includes(i.id)));
  };

  const onMenu = (id: string) => {
    const row = menu?.row;
    setMenu(null);
    if (!row) return;
    const doc = original(row.docIndex);
    switch (id) {
      case "edit":
        setDialog({ kind: "value", docIndex: row.docIndex, path: row.path });
        break;
      case "add":
        setDialog({ kind: "field", docIndex: row.docIndex, parent: row.path });
        break;
      case "json":
        setDialog({ kind: "document", docIndex: row.docIndex });
        break;
      case "unset":
        runtime.stageUnset(doc, row.path);
        break;
      case "copy":
        void copy(toShell(row.value));
        break;
      case "delete":
        void deleteDocument(row.docIndex);
        break;
    }
  };

  const openEdit = (row: TreeRow) => {
    if (readOnly) return say("This session is read-only");
    if (!row.isDoc && !row.described.container) {
      setDialog({ kind: "value", docIndex: row.docIndex, path: row.path });
    }
  };

  const canWrite = !readOnly && connection !== undefined;
  const pending = runtime.pendingCount;

  if (!connection) {
    return (
      <div className={styles.errorText} role="alert">
        The connection for this collection no longer exists.
      </div>
    );
  }

  const field = (
    name: "filter" | "project" | "sort",
    label: string,
    flex: string,
    placeholder: string,
  ) => (
    <div
      className={styles.field}
      style={{ flex }}
      data-invalid={error?.field === name ? "true" : undefined}
    >
      <label htmlFor={`${tab.id}-${name}`}>{label}</label>
      <input
        id={`${tab.id}-${name}`}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        value={draft[name]}
        onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            find();
          }
        }}
      />
    </div>
  );

  const statLine = loaded
    ? `${docs.length.toLocaleString()}${
        matched ? ` of ${matched.count.toLocaleString()}${matched.capped ? "+" : ""}` : ""
      } ${matched ? "matched" : docs.length === 1 ? "document" : "documents"}${
        elapsedMs !== null ? ` · ${elapsedMs} ms` : ""
      }`
    : "";

  return (
    <div className={styles.browser} data-shortcut-scope="documents">
      <header className={styles.header}>
        <nav aria-label="Breadcrumb" className={styles.crumbs}>
          <EnvDot env={BADGE_ENV[connection.environment]} size={8} />
          <span>{connection.name}</span>
          <ChevronRight size={10} />
          <span>{s.database}</span>
          <ChevronRight size={10} />
          <strong className={styles.crumbName}>{s.collection}</strong>
        </nav>
        <div role="tablist" aria-label="Collection views" className={styles.segmented}>
          {PANES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              className={styles.segment}
              aria-selected={s.pane === p.id}
              onClick={() => patchTab(tab.id, { pane: p.id })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className={styles.grow} />
        <ReadOnlyBadge
          connectionName={connection.name}
          environment={connection.environment}
          readOnly={readOnly}
          onChange={(ro) => void runtime.setReadOnly(ro)}
        />
        <Button
          variant="toolbar"
          onClick={() =>
            void runCommand("console.new", {
              connectionId: s.connectionId,
              database: s.database,
              sql: `db.${s.collection}.find({})`,
            })
          }
        >
          <Terminal size={13} />
          Open in console
        </Button>
      </header>

      {s.pane === "documents" ? (
        <>
          <div className={styles.queryBar}>
            {field("filter", "FILTER", "1 1 auto", '{ type: "checkout" }')}
            <div className={styles.queryRow}>
              {field("project", "PROJECT", "2 1 260px", "{ _id: 1, type: 1 }")}
              {field("sort", "SORT", "1 1 160px", "{ ts: -1 }")}
              <div className={styles.field} style={{ flex: "0 1 110px" }}>
                <label htmlFor={`${tab.id}-limit`}>LIMIT</label>
                <input
                  id={`${tab.id}-limit`}
                  inputMode="numeric"
                  placeholder="none"
                  value={draft.limit}
                  onChange={(e) => setDraft({ ...draft, limit: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      find();
                    }
                  }}
                />
              </div>
              <Button variant="primary" className={styles.findButton} onClick={find}>
                Find <span>{formatShortcut("Mod+Enter")}</span>
              </Button>
              {loading ? (
                <Button variant="default" onClick={() => void runtime.cancel()}>
                  Cancel
                </Button>
              ) : null}
            </div>
            {error ? (
              <div role="alert" className={styles.fieldError}>
                {error.message}
                {error.position ? ` (at character ${error.position})` : ""}
              </div>
            ) : null}
          </div>

          <div className={styles.toolbar}>
            <div role="tablist" aria-label="Document view mode" className={styles.segmented}>
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="tab"
                  className={styles.segmentSmall}
                  aria-selected={s.docView === v.id}
                  onClick={() => patchTab(tab.id, { docView: v.id })}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <IconButton
              aria-label="Insert document"
              disabled={!canWrite}
              onClick={() => setDialog({ kind: "insert" })}
            >
              <Plus size={14} />
            </IconButton>
            {s.docView === "tree" ? (
              <>
                <IconButton aria-label="Expand all" onClick={expandAll}>
                  <ChevronDown size={14} />
                </IconButton>
                <IconButton aria-label="Collapse all" onClick={() => setExpanded(new Set())}>
                  <ChevronRight size={14} />
                </IconButton>
              </>
            ) : null}
            <div className={styles.grow} />
            <span className={styles.stats} aria-live="polite">
              {statLine}
              {plan?.collscan ? (
                <>
                  {" · "}
                  <span className={styles.warn} title="No index supports this query">
                    COLLSCAN
                  </span>
                </>
              ) : plan?.index ? (
                ` · index ${plan.index}`
              ) : null}
            </span>
            <span style={{ position: "relative" }}>
              <Button
                variant="toolbar"
                aria-haspopup="menu"
                aria-expanded={exportMenu}
                onClick={() => setExportMenu((o) => !o)}
              >
                <Download size={13} />
                Export
                <ChevronDown size={12} />
              </Button>
              {exportMenu ? (
                <>
                  <div
                    className={styles.menuScrim}
                    onMouseDown={() => setExportMenu(false)}
                    aria-hidden="true"
                  />
                  <div
                    className={styles.popover}
                    style={{ position: "absolute", right: 0, top: 32, zIndex: 41 }}
                  >
                    <Menu
                      aria-label="Export format"
                      items={EXPORTS.map((f) => ({ id: f.id, label: f.label }))}
                      onClose={() => setExportMenu(false)}
                      onSelect={(id) => void doExport(EXPORTS.find((f) => f.id === id)!)}
                    />
                  </div>
                </>
              ) : null}
            </span>
          </div>

          {pending > 0 ? (
            <div className={styles.pending} role="status">
              <span>
                {pending} {pending === 1 ? "document has" : "documents have"} unsaved changes
              </span>
              <Button variant="primary" disabled={saving} onClick={save}>
                Save <span>{formatShortcut("Mod+S")}</span>
              </Button>
              <Button variant="default" disabled={saving} onClick={() => runtime.discard()}>
                Discard
              </Button>
              {saveError ? (
                <span role="alert" className={styles.fieldError}>
                  {saveError}
                </span>
              ) : null}
            </div>
          ) : saveError ? (
            <div role="alert" className={styles.errorText}>
              {saveError}
            </div>
          ) : null}

          <div
            className={styles.body}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) void runtime.loadMore();
            }}
          >
            {!loaded && loading ? <div className={styles.empty}>Loading…</div> : null}
            {loaded && docs.length === 0 ? (
              <div className={styles.empty}>No documents match.</div>
            ) : null}
            {loaded && docs.length > 0 && s.docView === "tree" ? (
              <TreeView
                rows={rows}
                editedPaths={(i) => runtime.editedPaths(docs[i])}
                selectedKey={selected}
                onSelect={(r) => setSelected(r.key)}
                onToggle={toggle}
                onEdit={openEdit}
                onContext={(row, e: MouseEvent) => setMenu({ row, x: e.clientX, y: e.clientY })}
              />
            ) : null}
            {loaded && docs.length > 0 && s.docView === "table" ? (
              <TableView
                docs={effectiveDocs}
                sort={s.sort}
                readOnly={!canWrite}
                onSort={(sort) => {
                  setDraft((d) => ({ ...d, sort }));
                  patchTab(tab.id, { sort });
                }}
                onEdit={(docIndex, key) => {
                  const v = getAt(effectiveDocs[docIndex], [key]);
                  if (v !== undefined && describe(v).container) {
                    setDialog({ kind: "document", docIndex });
                  } else {
                    setDialog({ kind: "value", docIndex, path: [key] });
                  }
                }}
                onNearEnd={() => void runtime.loadMore()}
              />
            ) : null}
            {loaded && docs.length > 0 && s.docView === "json" ? (
              <div>
                {effectiveDocs.map((d, i) => (
                  <div key={docKey(d)} className={styles.jsonDoc}>
                    <pre className={styles.json}>{toShell(d)}</pre>
                    <div className={styles.jsonDocActions}>
                      <Button variant="ghost" onClick={() => void copy(toShell(d))}>
                        Copy
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!canWrite}
                        onClick={() => setDialog({ kind: "document", docIndex: i })}
                      >
                        Edit
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {hasMore && s.docView !== "table" ? (
              <div className={styles.more}>
                <Button
                  variant="default"
                  disabled={fetching}
                  onClick={() => void runtime.loadMore()}
                >
                  {fetching ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {s.pane === "schema" ? (
        <div className={styles.body}>
          <SchemaPane runtime={runtime} />
        </div>
      ) : null}
      {s.pane === "indexes" ? (
        <div className={styles.body}>
          <IndexesPane runtime={runtime} />
        </div>
      ) : null}

      {menu ? (
        <>
          <div className={styles.menuScrim} onMouseDown={() => setMenu(null)} aria-hidden="true" />
          <div className={styles.popover} style={{ left: menu.x, top: menu.y }}>
            <Menu
              aria-label="Document actions"
              items={menuItems(menu.row)}
              onClose={() => setMenu(null)}
              onSelect={onMenu}
            />
          </div>
        </>
      ) : null}

      {dialog?.kind === "value" ? (
        <ValueEditDialog
          title={`Edit ${dialog.path.join(".")}`}
          initialType={describe(getAt(effectiveDocs[dialog.docIndex], dialog.path) ?? null).type}
          initialText={editText(getAt(effectiveDocs[dialog.docIndex], dialog.path) ?? null)}
          onClose={() => setDialog(null)}
          onSave={(_name, value) => {
            edit(dialog.docIndex, dialog.path, value);
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "field" ? (
        <ValueEditDialog
          title="Add field"
          askName
          takenNames={childrenOf(getAt(effectiveDocs[dialog.docIndex], dialog.parent) ?? null).map(
            ([k]) => k,
          )}
          initialType="String"
          initialText=""
          onClose={() => setDialog(null)}
          onSave={(name, value) => {
            const parent = getAt(effectiveDocs[dialog.docIndex], dialog.parent);
            const path = [...dialog.parent, Array.isArray(parent) ? String(parent.length) : name];
            edit(dialog.docIndex, path, value);
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "document" ? (
        <JsonEditDialog
          title="Edit document"
          saveLabel="Stage changes"
          initialText={toShell(effectiveDocs[dialog.docIndex])}
          onClose={() => setDialog(null)}
          onSave={async (text) => {
            const next = await runtime.evaluate(text);
            const before = effectiveDocs[dialog.docIndex] as { [k: string]: EJson };
            if (typeof next !== "object" || next === null || Array.isArray(next)) {
              throw new Error("A document is an object like { field: value }");
            }
            const after = next as { [k: string]: EJson };
            if (JSON.stringify(after._id) !== JSON.stringify(before._id)) {
              throw new Error("A document's _id can't be changed");
            }
            const doc = original(dialog.docIndex);
            for (const key of Object.keys(before)) {
              if (!(key in after)) runtime.stageUnset(doc, [key]);
            }
            for (const [key, value] of Object.entries(after)) {
              if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
                runtime.stageSet(doc, [key], value);
              }
            }
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "insert" ? (
        <JsonEditDialog
          title="Insert document"
          saveLabel="Insert"
          initialText={"{\n  \n}"}
          onClose={() => setDialog(null)}
          onSave={async (text) => {
            const value = await runtime.evaluate(text);
            const list = Array.isArray(value) ? value : [value];
            if (list.some((d) => typeof d !== "object" || d === null || Array.isArray(d))) {
              throw new Error("A document is an object like { field: value }");
            }
            const ok = await runtime.insert(list);
            if (ok) setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

async function confirmDiscard(runtime: CollectionRuntime): Promise<boolean> {
  const n = runtime.pendingCount;
  const choice = await askChoice({
    title: "Unsaved changes",
    body: (
      <p>
        {n} {n === 1 ? "document has" : "documents have"} unsaved changes. Discard them and run the
        query?
      </p>
    ),
    choices: [
      { id: "cancel", label: "Cancel" },
      { id: "discard", label: "Discard", variant: "primary" },
    ],
  });
  if (choice !== "discard") return false;
  runtime.discard();
  return true;
}

export { confirmDiscard };

/** The table view: top-level fields as columns, one document per row. */
function TableView({
  docs,
  sort,
  readOnly,
  onSort,
  onEdit,
  onNearEnd,
}: {
  docs: EJson[];
  sort: string;
  readOnly: boolean;
  onSort: (sort: string) => void;
  onEdit: (docIndex: number, key: string) => void;
  onNearEnd: () => void;
}) {
  const store = useRef(new ColumnarStore()).current;
  const model = useMemo(() => docsToTable(docs), [docs]);
  useMemo(() => {
    store.reset(model.columns);
    store.append(model.rows);
  }, [store, model]);

  // header click cycles ascending → descending → none on that one field
  const current = /^\s*\{\s*"?([^":\s]+)"?\s*:\s*(-?1)\s*\}\s*$/.exec(sort);
  const sortState = current
    ? {
        column: model.columns.findIndex((c) => c.name === current[1]),
        dir: current[2] === "1" ? ("asc" as const) : ("desc" as const),
      }
    : null;

  return (
    <div style={{ height: "100%", minHeight: 240 }}>
      <ResultGrid
        source={store}
        driver="mongodb"
        readOnly={readOnly}
        sort={sortState && sortState.column >= 0 ? sortState : null}
        onSort={(col) => {
          const name = model.columns[col]?.name;
          if (!name) return;
          if (current && current[1] === name) {
            onSort(current[2] === "1" ? `{ ${name}: -1 }` : "");
          } else {
            onSort(`{ ${name}: 1 }`);
          }
        }}
        onActivate={(col, row) => {
          if (readOnly) return false;
          const key = model.columns[col]?.name;
          if (key === undefined) return false;
          onEdit(row, key);
          return true;
        }}
        onNearEnd={onNearEnd}
      />
    </div>
  );
}

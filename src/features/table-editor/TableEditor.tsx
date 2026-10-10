import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { Badge } from "../../components/Badge";
import { Button, IconButton } from "../../components/Button";
import { Menu } from "../../components/Menu";
import type { MenuItem } from "../../components/Menu";
import { EnvDot } from "../../components/Badge";
import {
  ChevronRight,
  Download,
  PanelRight,
  Plus,
  Refresh,
  Terminal,
} from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import type { Value } from "../../lib/ipc/drivers";
import { runCommand } from "../../shell/registry/commands";
import { useWorkspace } from "../../stores/workspaceStore";
import { namespaceOf } from "../explorer/names";
import { ExportDialog } from "../grid/ExportDialog";
import type { ExportSource } from "../grid/ExportDialog";
import { ColumnsMenu } from "../grid/GridMenus";
import { ResultGrid } from "../grid/ResultGrid";
import { flavorOf, quoteIdent } from "../grid/sqlLiteral";
import { useGridView } from "../grid/useGridView";
import { visibleColumns } from "../grid/views";
import { tableQuerySql } from "./api";
import type { NewValue, PreviewStatement } from "./api";
import { confirmPending, readOnlyReason, submitChanges } from "./actions";
import { CellEditor } from "./CellEditor";
import { READ_ONLY_KINDS } from "./editValue";
import { PendingBar } from "./PendingBar";
import { RecordPanel } from "./RecordPanel";
import { loadReferencedBy, loadReferences } from "./recordData";
import type { ReferencedLink, ReferenceLink } from "./recordData";
import { format } from "../grid/copyFormats";
import { lookOf } from "../grid/cellStyle";
import { PreviewDialog } from "./PreviewDialog";
import { askChoice } from "../console/prompts";
import { useNotices } from "../../stores/noticesStore";
import { formatShortcut } from "../../lib/platform";
import type { GridDecorations } from "../grid/ResultGrid";
import { ColumnInput } from "./ColumnInput";
import { quickFilterSql, andWhere, orderFor, siblingTablePath, sortOf } from "./paths";
import type { QuickFilter } from "./paths";
import { getTableRuntime } from "./runtime";
import { DdlView, IndexesView, RelationsView, StructureView } from "./StructureViews";
import { PAGE_SIZES, tableName } from "./state";
import type { PageSize, TableTab, TableTabState, TableView } from "./state";
import styles from "./TableEditor.module.css";

const VIEWS: { id: TableView; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "structure", label: "Structure" },
  { id: "indexes", label: "Indexes" },
  { id: "relations", label: "Relations" },
  { id: "ddl", label: "DDL" },
];

const patchTab = (id: string, patch: Partial<TableTabState>) =>
  useWorkspace.getState().updateTabState<Partial<TableTabState>>(id, patch);

interface CellMenu {
  col: number;
  row: number;
  x: number;
  y: number;
}

export function TableEditor({ tab }: { tab: TableTab }) {
  const s = tab.state;
  const connection = useConnections((c) => c.file.connections.find((x) => x.id === s.connectionId));
  const runtime = useMemo(
    () => getTableRuntime(tab.id, s.connectionId, s.path),
    [tab.id, s.connectionId, s.path],
  );
  const meta = useStore(runtime.store, (r) => r.meta);
  const loading = useStore(runtime.store, (r) => r.loading);
  const loaded = useStore(runtime.store, (r) => r.loaded);
  const elapsed = useStore(runtime.store, (r) => r.elapsedMs);
  const total = useStore(runtime.store, (r) => r.total);
  const filterError = useStore(runtime.store, (r) => r.filterError);
  const loadError = useStore(runtime.store, (r) => r.loadError);
  const metaError = useStore(runtime.store, (r) => r.metaError);
  const ddl = useStore(runtime.store, (r) => r.ddl);
  const ddlError = useStore(runtime.store, (r) => r.ddlError);
  const keyColumns = useStore(runtime.store, (r) => r.keyColumns);
  const sql = useStore(runtime.store, (r) => r.sql);
  const submitError = useStore(runtime.store, (r) => r.submitError);
  const submitting = useStore(runtime.store, (r) => r.submitting);
  const changes = runtime.changes;
  const pendingRev = useSyncExternalStore(changes.subscribe, changes.getSnapshot);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(() => changes.counts(), [changes, pendingRev]);

  const driver = connection?.driver ?? "";
  const flavor = flavorOf(driver);
  const data = runtime.data;
  const gv = useGridView(data, {
    clientSort: false,
    resetKey: `${data.columns.length}:${data.columns[0]?.name}`,
  });

  const [whereDraft, setWhereDraft] = useState(s.where);
  const [orderDraft, setOrderDraft] = useState(s.orderBy);
  useEffect(() => setWhereDraft(s.where), [s.where]);
  useEffect(() => setOrderDraft(s.orderBy), [s.orderBy]);
  const [menu, setMenu] = useState<CellMenu | null>(null);
  const [exporting, setExporting] = useState(false);
  const whereInput = useRef<HTMLInputElement>(null);
  const [allRows, setAllRows] = useState<{ sql: string; table: string } | null>(null);

  // "Filter table by this column": start a condition in WHERE and leave the cursor after it.
  useEffect(() => {
    if (!s.focusColumn) return;
    setWhereDraft((cur) => andWhere(cur, `${quoteIdent(flavor, s.focusColumn!)} = `));
    patchTab(tab.id, { view: "data", focusColumn: undefined });
    requestAnimationFrame(() => whereInput.current?.focus());
  }, [s.focusColumn, tab.id, flavor]);

  // Exporting every row needs the query without its paging.
  useEffect(() => {
    if (!exporting) {
      setAllRows(null);
      return;
    }
    let live = true;
    tableQuerySql(s.connectionId, {
      path: s.path,
      whereClause: s.where || null,
      orderBy: s.orderBy || null,
      offset: 0,
      limit: 0,
      defaultOrder: keyColumns ?? [],
    })
      .then((q) => live && setAllRows({ sql: q.select, table: q.table }))
      .catch(() => live && setAllRows({ sql: "", table: "" }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exporting]);

  // Load the page whenever the applied query changes (or the tab comes back with none loaded).
  useEffect(() => {
    void runtime.loadIfNeeded({
      where: s.where,
      orderBy: s.orderBy,
      page: s.page,
      pageSize: s.pageSize,
    });
  }, [runtime, s.where, s.orderBy, s.page, s.pageSize]);

  // Structure, indexes and relations need the metadata; DDL needs the statement.
  useEffect(() => {
    if (s.view !== "data") void runtime.loadMeta();
    if (s.view === "ddl") void runtime.loadDdl();
  }, [runtime, s.view]);

  const columnNames = data.columns.map((c) => c.name);
  const names = meta ? meta.columns.map((c) => c.name) : columnNames;

  const fkColumns = useMemo(() => {
    const set = new Set<number>();
    for (const fk of meta?.foreignKeys ?? []) {
      for (const c of fk.columns) {
        const i = columnNames.indexOf(c);
        if (i >= 0) set.add(i);
      }
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, data.version]);
  const keySet = useMemo(
    () => new Set((keyColumns ?? []).map((c) => columnNames.indexOf(c)).filter((i) => i >= 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keyColumns, data.version],
  );
  const detailOf = useCallback(
    (col: number) => {
      const c = meta?.columns.find((x) => x.name === columnNames[col]);
      const type = c?.typeName ?? data.columns[col]?.type_name ?? "";
      const fk = meta?.foreignKeys.find((f) => f.columns.includes(columnNames[col]));
      if (fk)
        return `${type} → ${fk.refTable}.${fk.refColumns[fk.columns.indexOf(columnNames[col])] ?? ""}`;
      if (c?.primaryKey) return `${type} · PK`;
      return c?.nullable ? `${type} · nullable` : type;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta, data.version],
  );

  const isTable = s.path[s.path.length - 1]?.kind === "table";
  const reason = readOnlyReason(runtime, {
    isTable,
    connectionReadOnly: connection?.safeguards.readOnlyByDefault === true,
  });
  const canEdit = reason === null && loaded;
  runtime.editable = canEdit;
  const nullableOf = (col: number) =>
    meta?.columns.find((c) => c.name === columnNames[col])?.nullable !== false;
  const [editing, setEditing] = useState<{ col: number; row: number } | null>(null);
  const [preview, setPreview] = useState<{
    statements: PreviewStatement[] | null;
    error: string | null;
  } | null>(null);

  const startEdit = (col: number, row: number) => {
    if (changes.rowState(row) === "deleted") return;
    if (READ_ONLY_KINDS.has(data.columns[col]?.kind)) {
      useNotices.getState().push(`${columnNames[col]} can't be edited here (binary data)`);
      return;
    }
    setEditing({ col, row });
  };
  const stage = (col: number, row: number, value: NewValue) => changes.setCell(row, col, value);

  const decorations = useMemo<GridDecorations>(
    () => ({
      row: (r) => {
        const st = changes.rowState(r);
        if (st === "inserted") return { bg: "grid-inserted-row", marker: "+" };
        if (st === "deleted") return { bg: "grid-deleted-row", marker: "−", strike: true };
        if (st === "edited") return { bg: "grid-edited-row" };
        return undefined;
      },
      cell: (c, r) =>
        submitError?.row === r ? "error" : changes.isEdited(c, r) ? "edited" : undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changes, pendingRev, submitError],
  );

  const confirmReload = async () => {
    const answer = await askChoice({
      title: "Reload the table?",
      body: (
        <p>
          Reloading reads the rows again and drops all {counts.total} pending changes, so the
          changed row can be edited again from its current values.
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "reload", label: "Discard and reload", variant: "primary" },
      ],
    });
    if (answer === "reload") await runtime.discardAndReload();
  };

  const openPreview = () => {
    setPreview({ statements: null, error: null });
    runtime.previewChanges().then(
      (statements) => setPreview({ statements, error: null }),
      (e) => setPreview({ statements: null, error: String(e?.message ?? e) }),
    );
  };

  /** Run `go` once any pending edits are dealt with (submitted or discarded). */
  const guarded = (go: () => void) => void confirmPending(runtime).then((ok) => ok && go());

  const apply = (where = whereDraft, orderBy = orderDraft) =>
    guarded(() => patchTab(tab.id, { where, orderBy, page: 0 }));

  const sort = sortOf(flavor, s.orderBy, columnNames);
  const onSort = (col: number) => {
    const next = sort?.column === col ? (sort.dir === "asc" ? "desc" : null) : "asc";
    const orderBy = orderFor(flavor, columnNames[col], next);
    guarded(() => {
      setOrderDraft(orderBy);
      patchTab(tab.id, { orderBy, page: 0 });
    });
  };

  const from = s.page * s.pageSize + 1;
  const to = s.page * s.pageSize + data.rowCount;
  const lastPage =
    total.kind === "exact" || total.kind === "estimate"
      ? (s.page + 1) * s.pageSize >= total.rows
      : data.rowCount < s.pageSize;
  const range =
    data.rowCount === 0
      ? "No rows"
      : `Rows ${from.toLocaleString()}–${to.toLocaleString()}${
          total.kind === "exact"
            ? ` of ${total.rows.toLocaleString()}`
            : total.kind === "estimate"
              ? ` of ≈${total.rows.toLocaleString()}`
              : total.kind === "counting"
                ? " of …"
                : ""
        }${elapsed !== null ? ` · ${elapsed} ms` : ""}`;

  const openInConsole = () =>
    void runCommand("console.new", {
      connectionId: s.connectionId,
      ...namespaceOf(s.path),
      sql: sql ? `${sql};` : undefined,
    });

  const openTable = (schema: string | null, table: string, where?: string) =>
    void runCommand("table.open", {
      connectionId: s.connectionId,
      path: siblingTablePath(s.path, schema, table),
      where,
    });

  // --- record panel ----------------------------------------------------------------------------
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [references, setReferences] = useState<ReferenceLink[] | null>(null);
  const [referencedBy, setReferencedBy] = useState<ReferencedLink[] | null>(null);
  const recordRow =
    s.record && selectedRow !== null && selectedRow < changes.rowCount ? selectedRow : null;
  useEffect(() => {
    setReferences(null);
    setReferencedBy(null);
    if (recordRow === null || !meta || recordRow >= changes.loadedRows) return;
    let live = true;
    const values = columnNames.map((_, i) => changes.original(i, recordRow));
    void loadReferences(runtime, flavor, meta.foreignKeys, columnNames, values).then(
      (r) => live && setReferences(r),
    );
    void loadReferencedBy(runtime, flavor, meta.referencedBy, columnNames, values).then(
      (r) => live && setReferencedBy(r),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordRow, meta, data.version]);

  const recordValues = (row: number) => columnNames.map((_, i) => changes.get(i, row));
  const recordTitle = (row: number) => {
    const keys = (keyColumns ?? []).map((k) => columnNames.indexOf(k)).filter((i) => i >= 0);
    return keys.length > 0
      ? `Record #${keys.map((i) => lookOf(changes.get(i, row)).text).join(", ")}`
      : `Record · row ${row + 1}`;
  };
  const copyRecordJson = (row: number) => {
    const text = format({ columns: columnNames, rows: [recordValues(row)] }, "json", {
      flavor,
      table: "",
    });
    const one = JSON.parse(text) as unknown[];
    void navigator.clipboard.writeText(JSON.stringify(one[0] ?? {}, null, 2));
  };

  const exportSource = (): ExportSource => {
    const cols = visibleColumns(data.columns.length, gv.order, gv.hidden);
    return {
      loaded: () => ({
        columns: cols.map((c) => data.columns[c]),
        rows: Array.from({ length: data.rowCount }, (_, r) => cols.map((c) => data.get(c, r))),
      }),
      loadedCount: data.rowCount,
      hasMore: total.kind !== "exact" || total.rows > data.rowCount,
      sql: allRows?.sql || undefined,
      connectionId: s.connectionId,
      driver,
      tableName: allRows?.table || undefined,
      name: tableName(s.path),
    };
  };

  const menuSource = menu ? visibleColumns(data.columns.length, gv.order, gv.hidden)[menu.col] : -1;
  const menuItems: MenuItem[] = menu
    ? [
        ...(canEdit && changes.rowState(menu.row) !== "deleted"
          ? [
              { id: "edit", label: "Edit…" },
              ...(!nullableOf(menuSource) ? [] : [{ id: "setNull", label: "Set NULL" }]),
              ...(flavor === "sqlite" && menu.row < changes.loadedRows
                ? []
                : [{ id: "setDefault", label: "Set DEFAULT" }]),
            ]
          : []),
        { id: "equals", label: "Filter › Equals" },
        { id: "notEquals", label: "Filter › Not equals" },
        { id: "isNull", label: "Filter › Is NULL" },
        { id: "notNull", label: "Filter › Is not NULL" },
        ...(changes.get(menuSource, menu.row).kind === "text"
          ? [{ id: "contains", label: "Filter › Contains" }]
          : []),
      ]
    : [];
  const runQuickFilter = (op: QuickFilter) => {
    if (!menu) return;
    const sc = visibleColumns(data.columns.length, gv.order, gv.hidden)[menu.col];
    const value: Value = changes.get(sc, menu.row);
    const where = andWhere(s.where, quickFilterSql(flavor, columnNames[sc], value, op));
    setMenu(null);
    guarded(() => {
      setWhereDraft(where);
      patchTab(tab.id, { where, page: 0 });
    });
  };

  if (!connection) {
    return (
      <div className={styles.missing} role="alert">
        The connection for this table no longer exists.
      </div>
    );
  }

  const env = connection.environment;
  const guard = connection.safeguards;
  const pathNames = s.path.filter((seg) => seg.kind === "database" || seg.kind === "schema");

  return (
    <div className={styles.editor} data-shortcut-scope="grid">
      <header className={styles.header}>
        <nav aria-label="Breadcrumb" className={styles.crumbs}>
          <EnvDot env={BADGE_ENV[env]} size={8} />
          <span>{connection.name}</span>
          {pathNames.map((seg) => (
            <span key={seg.kind + seg.name} className={styles.crumb}>
              <ChevronRight size={10} />
              {seg.name}
            </span>
          ))}
          <span className={styles.crumb}>
            <ChevronRight size={10} />
            <strong className={styles.tableName}>{tableName(s.path)}</strong>
          </span>
        </nav>
        <div role="tablist" aria-label="Table views" className={styles.views}>
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={s.view === v.id}
              className={styles.view}
              onClick={() => patchTab(tab.id, { view: v.id })}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className={styles.grow} />
        {env === "production" ? (
          <Badge tone="production">
            PRODUCTION
            {guard.readOnlyByDefault
              ? " · READ-ONLY"
              : guard.confirmWrites
                ? " · WRITES NEED CONFIRMATION"
                : ""}
          </Badge>
        ) : null}
        <Button variant="default" onClick={openInConsole}>
          <Terminal size={13} />
          Open in console
        </Button>
      </header>

      {s.view === "data" ? (
        <>
          <div className={styles.filterBar}>
            <label htmlFor={`${tab.id}-where`} className={styles.kw}>
              WHERE
            </label>
            <div className={styles.filterField}>
              <ColumnInput
                id={`${tab.id}-where`}
                label="WHERE"
                value={whereDraft}
                onChange={setWhereDraft}
                onSubmit={() => apply()}
                columns={names}
                flavor={flavor}
                inputRef={whereInput}
                error={filterError && s.where === whereDraft ? filterError : null}
                invalid={Boolean(filterError)}
              />
            </div>
            <label htmlFor={`${tab.id}-order`} className={styles.kw}>
              ORDER BY
            </label>
            <div className={styles.orderField}>
              <ColumnInput
                id={`${tab.id}-order`}
                label="ORDER BY"
                value={orderDraft}
                onChange={setOrderDraft}
                onSubmit={() => apply()}
                columns={names}
                flavor={flavor}
              />
            </div>
            <IconButton
              aria-label="Clear filter"
              disabled={!whereDraft && !orderDraft && !s.where && !s.orderBy}
              onClick={() => {
                setWhereDraft("");
                setOrderDraft("");
                apply("", "");
              }}
            >
              ✕
            </IconButton>
          </div>

          <div className={styles.toolbar}>
            <IconButton
              aria-label="Refresh"
              onClick={() =>
                guarded(() => {
                  runtime.invalidate();
                  void runtime.load({
                    where: s.where,
                    orderBy: s.orderBy,
                    page: s.page,
                    pageSize: s.pageSize,
                  });
                })
              }
            >
              <Refresh size={14} />
            </IconButton>
            <IconButton
              aria-label="Add row"
              title={`Add row (${formatShortcut("Mod+N")})`}
              disabled={!canEdit}
              onClick={() => {
                const row = changes.addRow();
                const first = visibleColumns(data.columns.length, gv.order, gv.hidden)[0];
                if (first !== undefined) startEdit(first, row);
              }}
            >
              <Plus size={14} />
            </IconButton>
            <IconButton
              aria-label="Delete row"
              title={`Delete row (${formatShortcut("Mod+Backspace")})`}
              disabled={!canEdit}
              onClick={() => {
                if (runtime.selectedRows.length > 0) changes.deleteRows(runtime.selectedRows);
              }}
            >
              −
            </IconButton>
            <IconButton
              aria-label="Record panel"
              aria-pressed={s.record}
              title={`Record panel (${formatShortcut("Mod+Shift+R")})`}
              onClick={() => patchTab(tab.id, { record: !s.record })}
            >
              <PanelRight size={14} />
            </IconButton>
            <IconButton
              aria-label="Undo"
              title={`Undo (${formatShortcut("Mod+Z")})`}
              disabled={!canEdit || !changes.canUndo}
              onClick={() => changes.undo()}
            >
              ↶
            </IconButton>
            {reason ? (
              <span className={styles.readOnly} role="note">
                {reason}
              </span>
            ) : null}
            {data.columns.length > 0 ? (
              <ColumnsMenu
                columns={data.columns}
                hidden={gv.hidden}
                onToggle={gv.toggleColumn}
                onShowAll={gv.showAll}
              />
            ) : null}
            <button type="button" className={styles.textButton} onClick={() => setExporting(true)}>
              <Download size={13} />
              Export…
            </button>
            <div className={styles.grow} />
            <span className={styles.range} role="status">
              {loading && !loaded ? "Loading…" : range}
            </span>
            {total.kind === "unknown" && loaded ? (
              <button
                type="button"
                className={styles.link}
                onClick={() =>
                  void runtime.countExactly({
                    where: s.where,
                    orderBy: s.orderBy,
                    page: s.page,
                    pageSize: s.pageSize,
                  })
                }
              >
                Count exactly
              </button>
            ) : null}
            {total.kind === "estimate" ? (
              <button
                type="button"
                className={styles.link}
                onClick={() =>
                  void runtime.countExactly({
                    where: s.where,
                    orderBy: s.orderBy,
                    page: s.page,
                    pageSize: s.pageSize,
                  })
                }
              >
                Count exactly
              </button>
            ) : null}
            <IconButton
              aria-label="Previous page"
              disabled={s.page === 0 || loading}
              onClick={() => guarded(() => patchTab(tab.id, { page: s.page - 1 }))}
            >
              ‹
            </IconButton>
            <IconButton
              aria-label="Next page"
              disabled={lastPage || loading}
              onClick={() => guarded(() => patchTab(tab.id, { page: s.page + 1 }))}
            >
              ›
            </IconButton>
            <label className={styles.pageSize}>
              <span className="sr-only">Rows per page</span>
              <select
                value={s.pageSize}
                onChange={(e) => {
                  const pageSize = Number(e.target.value) as PageSize; // before the select snaps back
                  guarded(() => patchTab(tab.id, { pageSize, page: 0 }));
                }}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={styles.body}>
            <div className={styles.gridPane}>
              {loadError ? (
                <p className={styles.loadError} role="alert">
                  {loadError}
                </p>
              ) : null}
              {loaded ? (
                <ResultGrid
                  source={changes}
                  readOnly={!canEdit}
                  decorations={decorations}
                  onActivate={(col, row) => {
                    if (!canEdit) return false;
                    startEdit(col, row);
                    return true;
                  }}
                  onSelectionChange={(cells) => {
                    runtime.selectedRows = cells.rows;
                    setSelectedRow(
                      cells.rows.length === 1 ? cells.rows[0] : (cells.rows[0] ?? null),
                    );
                  }}
                  driver={driver}
                  fkColumns={fkColumns}
                  keyColumns={keySet}
                  headerDetail={detailOf}
                  sort={sort}
                  onSort={onSort}
                  hidden={gv.hidden}
                  order={gv.order}
                  onOrderChange={gv.setOrder}
                  widths={gv.widths}
                  onWidthsChange={gv.setWidths}
                  onCellContext={(col, row, x, y) => setMenu({ col, row, x, y })}
                />
              ) : !loadError ? (
                <p className={styles.viewEmpty}>Loading…</p>
              ) : null}
            </div>
            {s.record ? (
              recordRow !== null ? (
                <RecordPanel
                  columns={data.columns}
                  values={recordValues(recordRow)}
                  originals={columnNames.map((_, i) =>
                    recordRow < changes.loadedRows
                      ? changes.original(i, recordRow)
                      : changes.get(i, recordRow),
                  )}
                  title={recordTitle(recordRow)}
                  references={references}
                  referencedBy={referencedBy}
                  onCopyJson={() => copyRecordJson(recordRow)}
                  onFollow={(l) => openTable(l.fk.refSchema ?? null, l.fk.refTable, l.where)}
                  onOpenReferencing={(l) => openTable(l.ref.schema ?? null, l.ref.table, l.where)}
                  onClose={() => patchTab(tab.id, { record: false })}
                />
              ) : (
                <aside className={styles.record} aria-label="Record">
                  <p className={styles.viewEmpty}>Select a row to see its record.</p>
                </aside>
              )
            ) : null}
          </div>
        </>
      ) : (
        <div className={styles.body}>
          {metaError ? (
            <p className={styles.viewEmpty} role="alert">
              {metaError}
            </p>
          ) : s.view === "ddl" ? (
            <DdlView
              ddl={ddl}
              error={ddlError}
              onOpenInConsole={() =>
                void runCommand("console.new", {
                  connectionId: s.connectionId,
                  ...namespaceOf(s.path),
                  sql: ddl ?? undefined,
                })
              }
            />
          ) : !meta ? (
            <p className={styles.viewEmpty}>Loading…</p>
          ) : s.view === "structure" ? (
            <StructureView meta={meta} />
          ) : s.view === "indexes" ? (
            <IndexesView meta={meta} />
          ) : (
            <RelationsView meta={meta} onOpen={openTable} />
          )}
        </div>
      )}

      {menu ? (
        <>
          <div className={styles.scrim} onMouseDown={() => setMenu(null)} aria-hidden="true" />
          <div className={styles.menuHost} style={{ left: menu.x, top: menu.y }}>
            <Menu
              aria-label="Cell actions"
              items={menuItems}
              onClose={() => setMenu(null)}
              onSelect={(id) => {
                if (id === "edit") {
                  const at = menu;
                  setMenu(null);
                  startEdit(menuSource, at.row);
                } else if (id === "setNull") {
                  stage(menuSource, menu.row, { kind: "value", value: { kind: "null" } });
                  setMenu(null);
                } else if (id === "setDefault") {
                  stage(menuSource, menu.row, { kind: "default" });
                  setMenu(null);
                } else runQuickFilter(id as QuickFilter);
              }}
            />
          </div>
        </>
      ) : null}
      {s.view === "data" ? (
        <PendingBar
          counts={counts}
          submitting={submitting}
          error={submitError}
          submitShortcut={formatShortcut("Mod+S")}
          onPreview={openPreview}
          onRevert={() => {
            changes.clear();
            runtime.store.setState({ submitError: null });
          }}
          onSubmit={() => void submitChanges(runtime)}
          onReload={() => void confirmReload()}
        />
      ) : null}
      {editing ? (
        <CellEditor
          column={data.columns[editing.col]}
          current={changes.get(editing.col, editing.row)}
          nullable={nullableOf(editing.col)}
          allowDefault={flavor !== "sqlite" || editing.row >= changes.loadedRows}
          onClose={() => setEditing(null)}
          onSubmit={(value) => {
            stage(editing.col, editing.row, value);
            setEditing(null);
          }}
        />
      ) : null}
      {preview ? (
        <PreviewDialog
          statements={preview.statements}
          error={preview.error}
          onClose={() => setPreview(null)}
          onCopy={(text) => void navigator.clipboard.writeText(text)}
          onOpenInConsole={(text) => {
            setPreview(null);
            void runCommand("console.new", {
              connectionId: s.connectionId,
              ...namespaceOf(s.path),
              sql: text,
            });
          }}
        />
      ) : null}
      {exporting && allRows ? (
        <ExportDialog source={exportSource()} onClose={() => setExporting(false)} />
      ) : null}
    </div>
  );
}

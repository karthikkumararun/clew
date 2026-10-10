import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { Badge } from "../../components/Badge";
import { Button, IconButton } from "../../components/Button";
import { Menu } from "../../components/Menu";
import type { MenuItem } from "../../components/Menu";
import { EnvDot } from "../../components/Badge";
import { ChevronRight, Download, Refresh, Terminal } from "../../components/icons";
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

  const apply = (where = whereDraft, orderBy = orderDraft) =>
    patchTab(tab.id, { where, orderBy, page: 0 });

  const sort = sortOf(flavor, s.orderBy, columnNames);
  const onSort = (col: number) => {
    const next = sort?.column === col ? (sort.dir === "asc" ? "desc" : null) : "asc";
    const orderBy = orderFor(flavor, columnNames[col], next);
    setOrderDraft(orderBy);
    patchTab(tab.id, { orderBy, page: 0 });
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

  const openTable = (schema: string | null, table: string) =>
    void runCommand("table.open", {
      connectionId: s.connectionId,
      path: siblingTablePath(s.path, schema, table),
    });

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

  const menuItems: MenuItem[] = menu
    ? [
        { id: "equals", label: "Filter › Equals" },
        { id: "notEquals", label: "Filter › Not equals" },
        { id: "isNull", label: "Filter › Is NULL" },
        { id: "notNull", label: "Filter › Is not NULL" },
        ...(data.get(menu.col, menu.row).kind === "text"
          ? [{ id: "contains", label: "Filter › Contains" }]
          : []),
      ]
    : [];
  const runQuickFilter = (op: QuickFilter) => {
    if (!menu) return;
    const sc = visibleColumns(data.columns.length, gv.order, gv.hidden)[menu.col];
    const value: Value = data.get(sc, menu.row);
    const where = andWhere(s.where, quickFilterSql(flavor, columnNames[sc], value, op));
    setWhereDraft(where);
    patchTab(tab.id, { where, page: 0 });
    setMenu(null);
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
              onClick={() => {
                runtime.invalidate();
                void runtime.load({
                  where: s.where,
                  orderBy: s.orderBy,
                  page: s.page,
                  pageSize: s.pageSize,
                });
              }}
            >
              <Refresh size={14} />
            </IconButton>
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
              onClick={() => patchTab(tab.id, { page: s.page - 1 })}
            >
              ‹
            </IconButton>
            <IconButton
              aria-label="Next page"
              disabled={lastPage || loading}
              onClick={() => patchTab(tab.id, { page: s.page + 1 })}
            >
              ›
            </IconButton>
            <label className={styles.pageSize}>
              <span className="sr-only">Rows per page</span>
              <select
                value={s.pageSize}
                onChange={(e) =>
                  patchTab(tab.id, { pageSize: Number(e.target.value) as PageSize, page: 0 })
                }
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
                  source={data}
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
              onSelect={(id) => runQuickFilter(id as QuickFilter)}
            />
          </div>
        </>
      ) : null}
      {exporting && allRows ? (
        <ExportDialog source={exportSource()} onClose={() => setExporting(false)} />
      ) : null}
    </div>
  );
}

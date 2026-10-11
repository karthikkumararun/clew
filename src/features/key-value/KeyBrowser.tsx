import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { Button, IconButton } from "../../components/Button";
import { EnvDot } from "../../components/Badge";
import { Select } from "../../components/Input";
import { ChevronRight, Refresh, Terminal } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { runCommand } from "../../shell/registry/commands";
import { useWorkspace } from "../../stores/workspaceStore";
import { askChoice } from "../console/prompts";
import { ReadOnlyBadge } from "../safety/ReadOnlyBadge";
import { formatBytes, formatTtl, groupKeys, line, quote } from "./format";
import { PromptDialog } from "./Prompts";
import { getKeysRuntime } from "./runtime";
import type { KeysTab, KeysTabState } from "./state";
import { KeyBody } from "./Viewers";
import styles from "./KeyValue.module.css";

const patchTab = (id: string, patch: Partial<KeysTabState>) =>
  useWorkspace.getState().updateTabState<Partial<KeysTabState>>(id, patch);

type Dialog = "ttl" | "rename" | null;

export function KeyBrowser({ tab }: { tab: KeysTab }) {
  const s = tab.state;
  const connection = useConnections((c) => c.file.connections.find((x) => x.id === s.connectionId));
  const runtime = useMemo(() => getKeysRuntime(tab.id, s.connectionId), [tab.id, s.connectionId]);
  const keys = useStore(runtime.store, (r) => r.keys);
  const cursor = useStore(runtime.store, (r) => r.cursor);
  const scanning = useStore(runtime.store, (r) => r.scanning);
  const scanned = useStore(runtime.store, (r) => r.scanned);
  const listError = useStore(runtime.store, (r) => r.listError);
  const databases = useStore(runtime.store, (r) => r.databases);
  const detail = useStore(runtime.store, (r) => r.detail);
  const missing = useStore(runtime.store, (r) => r.missing);
  const detailLoading = useStore(runtime.store, (r) => r.detailLoading);
  const detailError = useStore(runtime.store, (r) => r.detailError);
  const page = useStore(runtime.store, (r) => r.page);
  const readOnly = useStore(runtime.store, (r) => r.readOnly);
  const editError = useStore(runtime.store, (r) => r.editError);

  const [draft, setDraft] = useState(s.pattern);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    void runtime.loadDatabases();
  }, [runtime]);
  useEffect(() => {
    void runtime.scanIfNeeded(s.db, s.pattern);
  }, [runtime, s.db, s.pattern]);
  useEffect(() => {
    if (s.selected) void runtime.open(s.db, s.selected);
    else runtime.close_key();
  }, [runtime, s.db, s.selected]);

  const grouped = useMemo(() => groupKeys(keys), [keys]);

  if (!connection) {
    return (
      <div className={styles.errorText} role="alert">
        The connection for this key browser no longer exists.
      </div>
    );
  }

  const dbCount = databases?.count ?? 16;
  const sizeOf = (i: number) => databases?.items.find(([d]) => d === i)?.[1];
  const applyPattern = () => patchTab(tab.id, { pattern: draft.trim(), selected: null });
  const toggle = (prefix: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });

  const deleteKey = async () => {
    if (!detail) return;
    const choice = await askChoice({
      title: "Delete this key?",
      body: (
        <p>
          {detail.name} will be removed from database {s.db}.
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "delete", label: "Delete", variant: "primary" },
      ],
    });
    if (choice !== "delete") return;
    if (await runtime.deleteKey(s.db, detail.name)) patchTab(tab.id, { selected: null });
  };

  const keyRow = (k: (typeof keys)[number], nested: boolean) => (
    <button
      key={k.name}
      type="button"
      role="option"
      aria-selected={s.selected === k.name}
      aria-label={k.name}
      className={`${styles.row} ${nested ? styles.child : ""}`}
      onClick={() => patchTab(tab.id, { selected: k.name })}
      title={k.name}
    >
      <span className={styles.rowName}>
        {nested ? k.name.slice(k.name.indexOf(":") + 1) : k.name}
      </span>
      <span className={styles.meta}>
        {k.type_name}
        {k.ttl_ms !== null ? ` · ${formatTtl(k.ttl_ms)}` : ""}
      </span>
    </button>
  );

  return (
    <div className={styles.browser}>
      <header className={styles.header}>
        <nav aria-label="Breadcrumb" className={styles.crumbs}>
          <EnvDot env={BADGE_ENV[connection.environment]} size={8} />
          <span>{connection.name}</span>
          <ChevronRight size={10} />
          <strong className={styles.crumbName}>db{s.db}</strong>
        </nav>
        <Select
          aria-label="Database"
          value={s.db}
          onChange={(e) => patchTab(tab.id, { db: Number(e.target.value), selected: null })}
        >
          {Array.from({ length: dbCount }, (_, i) => (
            <option key={i} value={i}>
              {`db${i}${sizeOf(i) !== undefined ? ` (${sizeOf(i)!.toLocaleString()})` : ""}`}
            </option>
          ))}
        </Select>
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
              database: `db${s.db}`,
              sql: "",
            })
          }
        >
          <Terminal size={13} />
          Open console
        </Button>
      </header>

      <div className={styles.split}>
        <aside className={styles.list} aria-label="Keys">
          <div className={styles.filter}>
            <input
              aria-label="Key pattern"
              placeholder="Filter, e.g. session:*"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (draft.trim() === s.pattern) void runtime.scan(s.db, s.pattern);
                  else applyPattern();
                }
              }}
            />
            <IconButton
              aria-label="Refresh keys"
              onClick={() => {
                void runtime.scan(s.db, s.pattern);
                void runtime.loadDatabases();
              }}
            >
              <Refresh size={14} />
            </IconButton>
          </div>
          {listError ? (
            <div role="alert" className={styles.filterError}>
              {listError}
            </div>
          ) : null}
          <div className={styles.keys} role="listbox" aria-label="Key list">
            {!scanned && scanning ? <div className={styles.empty}>Scanning…</div> : null}
            {scanned && keys.length === 0 && !listError ? (
              <div className={styles.empty}>
                {cursor !== "0" ? "No keys in this batch yet." : "No keys match."}
              </div>
            ) : null}
            {grouped.groups.map((g) => {
              const types = new Set(g.keys.map((k) => k.type_name));
              const expanded = open.has(g.prefix);
              return (
                <div key={g.prefix}>
                  <button
                    type="button"
                    className={styles.row}
                    aria-expanded={expanded}
                    onClick={() => toggle(g.prefix)}
                  >
                    <span className={styles.rowName}>
                      <span className={styles.groupCaret}>{expanded ? "▾" : "▸"}</span>
                      {g.label}
                    </span>
                    <span className={styles.meta}>
                      {g.keys.length.toLocaleString()} ·{" "}
                      {types.size === 1 ? [...types][0] : "mixed"}
                    </span>
                  </button>
                  {expanded ? g.keys.map((k) => keyRow(k, true)) : null}
                </div>
              );
            })}
            {grouped.plain.map((k) => keyRow(k, false))}
          </div>
          <div className={styles.listFooter}>
            <span>
              {keys.length.toLocaleString()} {keys.length === 1 ? "key" : "keys"}
              {cursor !== "0" ? " so far" : ""}
            </span>
            {cursor !== "0" ? (
              <Button
                variant="default"
                disabled={scanning}
                onClick={() => void runtime.more(s.db, s.pattern)}
              >
                {scanning ? "Scanning…" : "Load more"}
              </Button>
            ) : null}
          </div>
        </aside>

        <section className={styles.viewer} aria-label="Key viewer">
          {!s.selected ? (
            <div className={styles.empty}>Select a key to see its value.</div>
          ) : missing ? (
            <div className={styles.empty}>
              {s.selected} no longer exists — it may have expired or been deleted.
            </div>
          ) : detailError ? (
            <div role="alert" className={styles.errorText}>
              {detailError}
            </div>
          ) : !detail ? (
            <div className={styles.empty}>{detailLoading ? "Loading…" : ""}</div>
          ) : (
            <>
              <div className={styles.viewerHead}>
                <span className={styles.keyName}>{detail.name}</span>
                <span className={styles.typeChip}>{detail.type_name}</span>
                <div className={styles.grow} />
                <Button variant="toolbar" onClick={() => void runtime.open(s.db, detail.name)}>
                  Refresh
                </Button>
                <Button variant="toolbar" disabled={readOnly} onClick={() => setDialog("ttl")}>
                  TTL…
                </Button>
                <Button variant="toolbar" disabled={readOnly} onClick={() => setDialog("rename")}>
                  Rename…
                </Button>
                <Button variant="toolbar" disabled={readOnly} onClick={() => void deleteKey()}>
                  Delete
                </Button>
              </div>
              <div className={styles.facts}>
                TTL {formatTtl(detail.ttl_ms)} · {detail.size.toLocaleString()}{" "}
                {detail.type_name === "string"
                  ? "bytes"
                  : detail.size === 1
                    ? "element"
                    : "elements"}
                {detail.encoding ? ` · encoding ${detail.encoding}` : ""}
                {detail.memory !== null ? ` · ${formatBytes(detail.memory)} in memory` : ""}
              </div>
              {editError ? (
                <div role="alert" className={styles.errorText}>
                  {editError}
                </div>
              ) : null}
              {page.error ? (
                <div role="alert" className={styles.errorText}>
                  {page.error}
                </div>
              ) : null}
              <div className={styles.body}>
                <KeyBody
                  runtime={runtime}
                  db={s.db}
                  detail={detail}
                  page={page}
                  readOnly={readOnly}
                />
              </div>
            </>
          )}
        </section>
      </div>

      {dialog === "ttl" && detail ? (
        <PromptDialog
          title="Expiry"
          submitLabel="Set expiry"
          fields={[
            {
              id: "seconds",
              label: "Seconds until the key expires (empty keeps it forever)",
              initial: detail.ttl_ms !== null ? String(Math.ceil(detail.ttl_ms / 1000)) : "",
            },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const text = v.seconds.trim();
            if (text !== "" && !/^\d+$/.test(text))
              throw new Error("Use a whole number of seconds");
            const cmd =
              text === "" ? line("PERSIST", detail.name) : `EXPIRE ${quote(detail.name)} ${text}`;
            await runtime.edit(s.db, detail.name, cmd);
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === "rename" && detail ? (
        <PromptDialog
          title="Rename key"
          submitLabel="Rename"
          fields={[{ id: "to", label: "New name", initial: detail.name, required: true }]}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            if (v.to === detail.name) return setDialog(null);
            const ok = await runtime.renameKey(s.db, detail.name, v.to);
            if (!ok) {
              throw new Error(
                runtime.store.getState().editError ?? `A key called ${v.to} already exists`,
              );
            }
            patchTab(tab.id, { selected: v.to });
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

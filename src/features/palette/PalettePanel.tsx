import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { EnvDot } from "../../components/Badge";
import { Clock, File, Graph, Search, Table, Terminal } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { formatShortcut } from "../../lib/platform";
import { runCommand } from "../../shell/registry/commands";
import { eventCombo } from "../../shell/registry/shortcuts";
import { highlightRuns } from "./fuzzy";
import type { ItemIcon, PaletteItem } from "./items";
import { SCOPES, cycleScope, usePalette } from "./paletteStore";
import { usePaletteResults } from "./usePaletteResults";
import styles from "./Palette.module.css";

const ICONS: Record<ItemIcon, (p: { size?: number }) => JSX.Element> = {
  table: (p) => <Table {...p} />,
  column: (p) => <Table {...p} />,
  graph: (p) => <Graph {...p} />,
  history: (p) => <Clock {...p} />,
  file: (p) => <File {...p} />,
  action: (p) => <Terminal {...p} />,
  field: () => <span className={styles.braces}>{"{ }"}</span>,
};

function Label({ item }: { item: PaletteItem }) {
  return (
    <span className={item.mono ? styles.labelMono : styles.label}>
      {highlightRuns(item.label, item.indices).map((run, i) =>
        run.hit ? (
          <span key={i} className={styles.hl}>
            {run.text}
          </span>
        ) : (
          run.text
        ),
      )}
    </span>
  );
}

function Row({
  item,
  id,
  active,
  onHover,
  onPick,
}: {
  item: PaletteItem;
  id: string;
  active: boolean;
  onHover: () => void;
  onPick: (alt: boolean) => void;
}) {
  const Icon = ICONS[item.icon];
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className={styles.item}
      data-active={active}
      data-icon={item.icon}
      onMouseMove={onHover}
      onClick={(e) => onPick(e.altKey)}
    >
      <span className={styles.icon} data-kind={item.icon} aria-hidden="true">
        <Icon size={14} />
      </span>
      <Label item={item} />
      {item.connection ? (
        <span className={styles.where}>
          <EnvDot env={item.connection.env} />
          <span className={styles.whereText}>
            {item.connection.name}
            {item.detail ? ` · ${item.detail}` : ""}
          </span>
        </span>
      ) : null}
      <span className={styles.meta}>
        {active && item.hint ? (
          item.hint
        ) : item.shortcut ? (
          <kbd className={styles.kbd}>{item.shortcut}</kbd>
        ) : (
          item.meta
        )}
      </span>
    </div>
  );
}

/** The command palette (spec: command-palette › Open the palette). */
export function PalettePanel() {
  const open = usePalette((s) => s.open);
  return open ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const scope = usePalette((s) => s.scope);
  const preset = usePalette((s) => s.preset);
  const setScope = usePalette((s) => s.setScope);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();
  const { groups, stats, searched } = usePaletteResults(query, scope, preset, refreshKey);
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const connected = useConnections((s) => s.connected);
  const connections = useConnections((s) => s.file.connections);
  const anyDisconnected = connections.some((c) => !connected[c.id]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setActive(0), [query, scope, preset]);
  useEffect(() => {
    list.current?.querySelector(`[data-active="true"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, items]);

  const close = () => usePalette.getState().close();
  const choose = (item: PaletteItem | undefined, alt: boolean) => {
    if (!item) return;
    // Close without taking focus back: what the item opens decides where focus goes.
    usePalette.setState({ open: false, preset: null, returnFocus: null });
    void (alt && item.alt ? item.alt() : item.run());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const combo = eventCombo(e.nativeEvent);
    if (combo === "Mod+K") {
      e.preventDefault();
      close();
    } else if (combo === "Mod+E") {
      e.preventDefault();
      usePalette.getState().show({ scope: "queries", preset: "recent" });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) {
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active], e.altKey);
    } else if (e.key === "Tab") {
      e.preventDefault();
      setScope(cycleScope(scope, e.shiftKey ? -1 : 1));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const refresh = async () => {
    await runCommand("palette.refreshIndex");
    setRefreshKey((k) => k + 1);
  };

  let row = -1;
  return createPortal(
    <div className={styles.backdrop} data-dialog-root>
      <div className={styles.scrim} onMouseDown={close} aria-hidden="true" />
      <div
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-metric="palette"
      >
        <div className={styles.search}>
          <Search size={16} className={styles.searchIcon} />
          <label htmlFor={`${uid}-q`} className={styles.srOnly}>
            Search
          </label>
          <input
            id={`${uid}-q`}
            ref={input}
            className={styles.input}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${uid}-list`}
            aria-activedescendant={items[active] ? `${uid}-r${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={preset ? "Recent files and saved queries" : "Go to table, query, action…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div role="tablist" aria-label="Scope" className={styles.scopes}>
            {SCOPES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={scope === s.id}
                tabIndex={-1}
                className={styles.scope}
                onClick={() => {
                  setScope(s.id);
                  input.current?.focus();
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div
          ref={list}
          id={`${uid}-list`}
          role="listbox"
          aria-label="Results"
          className={styles.results}
          data-metric="palette-results"
        >
          {groups.map((g) => (
            <div key={g.id} role="group" aria-label={g.label}>
              <div className={styles.group}>{g.label}</div>
              {g.items.map((item) => {
                const i = ++row;
                return (
                  <Row
                    key={item.id}
                    item={item}
                    id={`${uid}-r${i}`}
                    active={i === active}
                    onHover={() => setActive(i)}
                    onPick={(alt) => choose(item, alt)}
                  />
                );
              })}
            </div>
          ))}
          {items.length === 0 && searched ? (
            <div className={styles.empty} role="status">
              <strong>No matches</strong>
              {anyDisconnected ? (
                <span>
                  Objects of disconnected connections are searched from their last index.{" "}
                  <button type="button" className={styles.link} onClick={() => void refresh()}>
                    Refresh index
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className={styles.footer} data-testid="palette-footer">
          <span>
            <kbd className={styles.kbd}>↑↓</kbd> move
          </span>
          <span>
            <kbd className={styles.kbd}>↵</kbd> open
          </span>
          <span>
            <kbd className={styles.kbd}>{formatShortcut("Alt+Enter")}</kbd> query in console
          </span>
          <span>
            <kbd className={styles.kbd}>⇥</kbd> scope
          </span>
          <span className={styles.grow} />
          <span title="Refresh index runs from the Actions list">
            Searching {stats.connections} {stats.connections === 1 ? "connection" : "connections"} ·{" "}
            {stats.objects.toLocaleString("en-US")} objects indexed
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

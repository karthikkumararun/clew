import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Checkbox, Input, SegmentedControl } from "../components/Input";
import { Dialog } from "../components/Dialog";
import { AiSettingsPage } from "../features/ai/AiSettingsPage";
import { formatShortcut } from "../lib/platform";
import { IDLE_MINUTES_RANGE, useSessionSettings } from "../stores/sessionSettings";
import { FONT_SIZE_RANGE, PAGE_SIZES, useSettings } from "../stores/settingsStore";
import { listCommands, subscribeCommands } from "./registry/commands";
import styles from "./SettingsDialog.module.css";

export const SECTIONS = [
  "General",
  "Editor",
  "Data grid",
  "Sessions",
  "Keymap",
  "AI assistant",
  "Updates",
] as const;

function Section({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <>
      <div>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.lede}>{lede}</p>
      </div>
      {children}
    </>
  );
}

function General() {
  const { settings, set } = useSettings();
  return (
    <Section title="General" lede="Everyday behaviour. Changes apply immediately.">
      <div className={styles.card}>
        <Checkbox
          label="Confirm before closing a tab with unsaved changes"
          description="You'll be asked to Save, Discard or Cancel."
          checked={settings.confirmCloseUnsaved}
          onChange={(e) => set({ confirmCloseUnsaved: e.target.checked })}
        />
      </div>
    </Section>
  );
}

function Editor() {
  const { settings, set } = useSettings();
  // Keep a local draft so the field can be cleared while typing; commit valid numbers only.
  const [draft, setDraft] = useState(String(settings.editorFontSize));
  useEffect(() => setDraft(String(settings.editorFontSize)), [settings.editorFontSize]);
  const commit = (value: string) => {
    const n = Number(value);
    if (Number.isFinite(n) && value.trim() !== "") set({ editorFontSize: n });
    else setDraft(String(settings.editorFontSize));
  };
  return (
    <Section title="Editor" lede="Font settings for SQL and script editors.">
      <div className={styles.card}>
        <div className={styles.field}>
          <label htmlFor="set-font-size" className={styles.fieldLabel}>
            Editor font size
          </label>
          <div className={styles.row}>
            <Input
              id="set-font-size"
              dialog
              type="number"
              min={FONT_SIZE_RANGE.min}
              max={FONT_SIZE_RANGE.max}
              value={draft}
              style={{ width: 90 }}
              onChange={(e) => {
                setDraft(e.target.value);
                const n = Number(e.target.value);
                if (
                  e.target.value.trim() !== "" &&
                  n >= FONT_SIZE_RANGE.min &&
                  n <= FONT_SIZE_RANGE.max
                )
                  set({ editorFontSize: n });
              }}
              onBlur={(e) => commit(e.target.value)}
            />
            <span className={styles.muted}>px</span>
          </div>
          <p className={styles.help}>
            {FONT_SIZE_RANGE.min}–{FONT_SIZE_RANGE.max}. Default 13.
          </p>
        </div>
      </div>
    </Section>
  );
}

function DataGrid() {
  const { settings, set } = useSettings();
  return (
    <Section
      title="Data grid"
      lede="How the grid loads and shows rows, and how console results behave."
    >
      <div className={styles.card}>
        <div className={styles.field}>
          <span className={styles.fieldLabel} id="set-page-size">
            Rows per page
          </span>
          <SegmentedControl
            aria-label="Rows per page"
            value={settings.gridPageSize}
            options={PAGE_SIZES.map((n) => ({ value: n, label: String(n) }))}
            onChange={(n) => set({ gridPageSize: n })}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Console results</span>
          <SegmentedControl
            aria-label="Browse console results"
            value={settings.resultBrowse}
            options={[
              { value: "scroll", label: "Scroll" },
              { value: "pages", label: "Pages" },
            ]}
            onChange={(v) => set({ resultBrowse: v })}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Page size</span>
          <SegmentedControl
            aria-label="Result page size"
            value={settings.resultPageSize}
            options={[100, 500, 1000].map((n) => ({ value: n, label: String(n) }))}
            onChange={(n) => set({ resultPageSize: n })}
          />
        </div>
        <Checkbox
          label="Re-run a result after submitting changes"
          description="Only for results of at most 1,000 rows; shows computed columns up to date."
          checked={settings.resultAutoRerun}
          onChange={(e) => set({ resultAutoRerun: e.target.checked })}
        />
      </div>
    </Section>
  );
}

function MinutesField({
  id,
  label,
  help,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  help: string;
  value: number;
  onCommit: (minutes: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      <div className={styles.row}>
        <Input
          id={id}
          dialog
          type="number"
          min={IDLE_MINUTES_RANGE.min}
          max={IDLE_MINUTES_RANGE.max}
          value={draft}
          style={{ width: 90 }}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = Number(e.target.value);
            if (
              e.target.value.trim() !== "" &&
              n >= IDLE_MINUTES_RANGE.min &&
              n <= IDLE_MINUTES_RANGE.max
            )
              onCommit(n);
          }}
          onBlur={() => setDraft(String(value))}
        />
        <span className={styles.muted}>minutes</span>
      </div>
      <p className={styles.help}>{help}</p>
    </div>
  );
}

function Sessions() {
  const { settings, set } = useSessionSettings();
  return (
    <Section
      title="Sessions"
      lede="A session with an open transaction and no activity is flagged as idle in transaction."
    >
      <div className={styles.card}>
        <MinutesField
          id="set-idle-default"
          label="Idle threshold"
          help="Staging and other connections. Default 5."
          value={settings.idleMinutes}
          onCommit={(n) => set({ idleMinutes: n })}
        />
        <MinutesField
          id="set-idle-production"
          label="Idle threshold on production"
          help="Default 2."
          value={settings.production}
          onCommit={(n) => set({ production: n })}
        />
        <MinutesField
          id="set-idle-local"
          label="Idle threshold on local and development"
          help="Default 15. These connections show the warning mark only, never a notification."
          value={settings.local}
          onCommit={(n) => set({ local: n })}
        />
        <Checkbox
          label="Notify when a transaction goes idle"
          description="One notification per transaction, with Roll back and Show. Not shown for local or development connections."
          checked={settings.notify}
          onChange={(e) => set({ notify: e.target.checked })}
        />
      </div>
    </Section>
  );
}

function Keymap() {
  const [, force] = useState(0);
  useEffect(() => subscribeCommands(() => force((n) => n + 1)), []);
  const rows = listCommands().filter((c) => c.shortcut);
  return (
    <Section title="Keymap" lede="Shortcuts use Cmd on macOS and Ctrl on Windows.">
      <div className={styles.card}>
        {rows.length === 0 ? (
          <p className={styles.help}>No shortcuts registered.</p>
        ) : (
          <div className={styles.keymap}>
            {rows.map((c) => (
              <div key={c.id} style={{ display: "contents" }}>
                <div>{c.title}</div>
                <div className={styles.keys}>{formatShortcut(c.shortcut as string)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

function Updates() {
  const { settings, set } = useSettings();
  return (
    <Section
      title="Updates"
      lede="Clew makes no network requests of its own unless you turn this on."
    >
      <div className={styles.card}>
        <Checkbox
          label="Check for updates"
          description="Off by default. When on, Clew looks for a newer release at startup."
          checked={settings.checkForUpdates}
          onChange={(e) => set({ checkForUpdates: e.target.checked })}
        />
      </div>
    </Section>
  );
}

const PANELS: Record<(typeof SECTIONS)[number], () => ReactNode> = {
  General,
  Editor,
  "Data grid": DataGrid,
  Sessions,
  Keymap,
  "AI assistant": AiSettingsPage,
  Updates,
};

export function SettingsDialog() {
  const open = useSettings((s) => s.dialogOpen);
  const section = useSettings((s) => s.section) as (typeof SECTIONS)[number];
  const setSection = useSettings((s) => s.setSection);
  const close = useSettings((s) => s.closeDialog);
  if (!open) return null;
  const Panel = PANELS[section] ?? General;
  return (
    <Dialog title="Settings" maxWidth={1120} onClose={close}>
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={styles.navItem}
              aria-current={s === section ? "page" : undefined}
              onClick={() => setSection(s)}
            >
              {s}
            </button>
          ))}
        </nav>
        <div className={styles.content}>
          <Panel />
        </div>
      </div>
    </Dialog>
  );
}

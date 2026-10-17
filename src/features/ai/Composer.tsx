import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { EnvDot } from "../../components/Badge";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { Menu } from "../../components/Menu";
import { ChevronDown, Close } from "../../components/icons";
import { BADGE_ENV } from "../../connections/display";
import type { Connection } from "../../connections/api";
import { useNotices } from "../../stores/noticesStore";
import { loadSnapshot, peekSnapshot } from "../console/completion/snapshots";
import { aiPolicy } from "./api";
import { consoleContext, currentRows, defaultDatabase, lastError } from "./activeContext";
import { EMPTY_COMPOSER, useChat } from "./chatStore";
import type { Attachment } from "./chatStore";
import { configuredProviders } from "./settingsStore";
import { shortModel } from "./providers";
import { SLASH, currentModel, parseSlash, sendMessage, stopRunning } from "./send";
import styles from "./Panel.module.css";

/** Where the composer's textarea is, so Mod+I can focus it. */
let textarea: HTMLTextAreaElement | null = null;
export const focusComposer = () => textarea?.focus();

const ROWS_OFF = "Sharing sample rows is turned off in Settings › AI assistant";

type Picker =
  { kind: "mention"; query: string; start: number } | { kind: "slash"; query: string } | null;

/** The `@word` or leading `/word` the caret is in. */
export function pickerAt(text: string, caret: number): Picker {
  const before = text.slice(0, caret);
  const mention = /(?:^|\s)@([\w.$]*)$/.exec(before);
  if (mention) return { kind: "mention", query: mention[1], start: caret - mention[1].length - 1 };
  const slash = /^\/([a-z]*)$/i.exec(before);
  if (slash) return { kind: "slash", query: slash[1].toLowerCase() };
  return null;
}

/** Table (or label) names a message can mention. */
export function mentionNames(connectionId: string, database: string): string[] {
  const snap = peekSnapshot(connectionId, database);
  if (!snap) return [];
  const tables = snap.schemas.flatMap((s) => s.tables.map((t) => t.name));
  const graph = snap.graph
    ? [...snap.graph.labels, ...snap.graph.relationshipTypes].map((x) => x.name)
    : [];
  return [...new Set([...tables, ...graph])].sort((a, b) => a.localeCompare(b));
}

export function Composer({ connection }: { connection: Connection }) {
  const id = connection.id;
  const composer = useChat((s) => s.composers[id] ?? EMPTY_COMPOSER);
  const mode = useChat((s) => s.mode);
  const running = useChat((s) => s.running);
  const setMode = useChat((s) => s.setMode);
  const setComposer = useChat((s) => s.setComposer);
  const setPick = useChat((s) => s.setPick);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [menu, setMenu] = useState<"context" | "model" | null>(null);
  const modelBtn = useRef<HTMLButtonElement>(null);
  const contextBtn = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const database = consoleContext(id)?.database ?? defaultDatabase(id);
  const model = currentModel();
  const busy = running !== null;
  /** Close the open menu and give focus back to its button. */
  const closeMenu = () => {
    const which = menu;
    setMenu(null);
    (which === "model" ? modelBtn : contextBtn).current?.focus();
  };

  useEffect(() => {
    const node = area.current;
    textarea = node;
    return () => {
      if (textarea === node) textarea = null;
    };
  }, []);
  // The tables to mention come from the completion snapshot; fetch it when the composer opens.
  useEffect(() => {
    void loadSnapshot(id, database).catch(() => {});
  }, [id, database]);

  const picker = dismissed === composer.text ? null : pickerAt(composer.text, caret);
  const options = useMemo(() => {
    if (!picker) return [];
    if (picker.kind === "slash") {
      return SLASH.filter((c) => c.name.startsWith(picker.query)).map((c) => ({
        key: `/${c.name}`,
        label: `/${c.name}`,
        hint: c.hint,
      }));
    }
    const q = picker.query.toLowerCase();
    return mentionNames(id, database)
      .filter((n) => n.toLowerCase().includes(q))
      .slice(0, 8)
      .map((n) => ({ key: n, label: n, hint: "" }));
  }, [picker, id, database]);

  const set = (change: Partial<typeof composer>) => setComposer(id, change);

  const choose = (key: string) => {
    if (!picker) return;
    let text: string;
    let at: number;
    if (picker.kind === "slash") {
      text = `${key} `;
      at = text.length;
      set({ text });
    } else {
      const inserted = `@${key} `;
      text = `${composer.text.slice(0, picker.start)}${inserted}${composer.text.slice(caret)}`;
      at = picker.start + inserted.length;
      set({
        text,
        mentions: composer.mentions.includes(key) ? composer.mentions : [...composer.mentions, key],
      });
    }
    setCaret(at);
    setActive(0);
    const node = area.current;
    node?.focus();
    // After React has put the new text in, so the caret lands behind the inserted word.
    queueMicrotask(() => node?.setSelectionRange(at, at));
  };

  const submit = () => {
    const text = composer.text.trim();
    if (!text || busy) return;
    // Mentions that are still in the text.
    const mentions = composer.mentions.filter((m) => text.includes(`@${m}`));
    void sendMessage(id, text, { mentions, attachments: composer.attachments });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // A command typed out in full is sent, not completed.
    const complete =
      picker?.kind === "slash" && options.some((o) => o.key === composer.text.trim());
    if (picker && options.length > 0 && !complete) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(options[Math.min(active, options.length - 1)].key);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(composer.text);
        return;
      }
    }
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      stopRunning();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const attach = async (kind: "selection" | "error" | "rows") => {
    setMenu(null);
    const say = (m: string) => useNotices.getState().push(m);
    let a: Attachment | null;
    if (kind === "selection") {
      const c = consoleContext(id);
      if (!c?.selection || !c.statement.trim()) return say("Select some SQL in the editor first");
      a = { kind, label: "selection", text: c.statement };
    } else if (kind === "error") {
      a = lastError(id);
      if (!a) return say("There is no error to attach");
    } else {
      try {
        const access = await aiPolicy(id);
        if (!access.rows)
          return say(
            access.production ? "Row data isn't shared for Production connections" : ROWS_OFF,
          );
      } catch {
        /* the request will be checked again by the backend */
      }
      a = currentRows(id);
      if (!a) return say("There are no result rows to attach");
    }
    const kept = composer.attachments.filter((x) => x.kind !== kind);
    set({ attachments: [...kept, a] });
  };

  const slashParsed = parseSlash(composer.text);
  const providers = configuredProviders();

  return (
    <div className={styles.composer}>
      <div className={styles.chips}>
        <span className={styles.chip}>
          <EnvDot env={BADGE_ENV[connection.environment]} />
          {connection.name}
        </span>
        {composer.mentions.map((m) => (
          <span key={m} className={`${styles.chip} ${styles.mono}`}>
            @{m}
            <button
              type="button"
              className={styles.chipX}
              aria-label={`Remove @${m}`}
              onClick={() => set({ mentions: composer.mentions.filter((x) => x !== m) })}
            >
              <Close size={9} />
            </button>
          </span>
        ))}
        {composer.attachments.map((a) => (
          <span
            key={a.kind}
            className={`${styles.chip} ${a.kind === "error" ? styles.chipError : ""}`}
          >
            {a.label}
            <button
              type="button"
              className={styles.chipX}
              aria-label={`Remove ${a.label}`}
              onClick={() => set({ attachments: composer.attachments.filter((x) => x !== a) })}
            >
              <Close size={9} />
            </button>
          </span>
        ))}
        <button
          ref={contextBtn}
          type="button"
          className={`${styles.chip} ${styles.chipDashed}`}
          aria-haspopup="menu"
          aria-expanded={menu === "context"}
          onClick={() => setMenu(menu === "context" ? null : "context")}
        >
          + context
        </button>
      </div>
      {menu === "context" ? (
        <AnchoredMenu anchor={contextBtn}>
          <Menu
            aria-label="Add context"
            items={[
              { id: "selection", label: "Selected SQL" },
              { id: "error", label: "Last error" },
              { id: "rows", label: "Result rows (up to 20)" },
            ]}
            onClose={closeMenu}
            onSelect={(k) => void attach(k as "selection" | "error" | "rows")}
          />
        </AnchoredMenu>
      ) : null}

      <div className={styles.inputWrap}>
        {picker && options.length > 0 ? (
          <ul
            className={styles.picker}
            role="listbox"
            aria-label={picker.kind === "slash" ? "Commands" : "Tables"}
          >
            {options.map((o, i) => (
              <li
                key={o.key}
                role="option"
                aria-selected={i === Math.min(active, options.length - 1)}
                className={styles.pickerItem}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o.key);
                }}
              >
                <span className={styles.mono}>{o.label}</span>
                {o.hint ? <span className={styles.pickerHint}>{o.hint}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <label htmlFor="ai-ask" className={styles.srOnly}>
          Ask the assistant
        </label>
        <textarea
          id="ai-ask"
          ref={area}
          className={styles.textarea}
          rows={3}
          placeholder={`Ask about ${connection.name}…  @ to mention a table, / for commands`}
          value={composer.text}
          onChange={(e) => {
            set({ text: e.target.value });
            setCaret(e.target.selectionStart);
            setActive(0);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className={styles.controls}>
        <div role="radiogroup" aria-label="Assistant mode" className={styles.segmented}>
          {(["ask", "edit"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
            >
              {m === "ask" ? "Ask" : "Edit"}
            </button>
          ))}
        </div>
        <button
          ref={modelBtn}
          type="button"
          className={styles.modelButton}
          aria-label={model ? `Model: ${model.cfg.name} ${shortModel(model.model)}` : "Model"}
          aria-haspopup="menu"
          aria-expanded={menu === "model"}
          onClick={() => setMenu(menu === "model" ? null : "model")}
        >
          <span
            className={styles.modelDot}
            style={{ background: model ? providerColor(model.cfg.kind) : undefined }}
          />
          {model ? shortModel(model.model || model.cfg.name) || model.cfg.name : "No model"}
          <ChevronDown size={11} />
        </button>
        {menu === "model" ? (
          <AnchoredMenu anchor={modelBtn}>
            <Menu
              aria-label="Model"
              items={providers.map((p) => ({
                id: p.id,
                label: p.model ? `${p.name} · ${shortModel(p.model)}` : p.name,
              }))}
              onClose={closeMenu}
              onSelect={(pid) => {
                const p = providers.find((x) => x.id === pid);
                if (p) setPick({ providerId: p.id, model: p.model });
                closeMenu();
              }}
            />
          </AnchoredMenu>
        ) : null}
        <span className={styles.grow} />
        {busy ? (
          <button type="button" className={styles.send} aria-label="Stop" onClick={stopRunning}>
            <span className={styles.stopSquare} />
          </button>
        ) : (
          <button
            type="button"
            className={styles.send}
            aria-label="Send"
            disabled={
              !composer.text.trim() ||
              (slashParsed?.command.name === "generate" && !slashParsed.rest)
            }
            onClick={submit}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function providerColor(kind: string): string {
  if (kind === "anthropic" || kind === "custom_anthropic") return "var(--ai-claude)";
  if (kind === "openai") return "var(--ai-openai)";
  if (kind === "local") return "var(--ai-local)";
  return "var(--ai-custom)";
}

import { Fragment } from "react";
import type { ReactNode } from "react";
import styles from "./Markdown.module.css";

export type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; lang: string; text: string; open: boolean };

/**
 * Split an answer into blocks. Unclosed fences (an answer still streaming) are code to the end.
 */
export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ").trim() });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const body: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (/^\s*```\s*$/.test(lines[i])) {
          closed = true;
          break;
        }
        body.push(lines[i]);
      }
      blocks.push({
        kind: "code",
        lang: fence[1].toLowerCase(),
        text: body.join("\n"),
        open: !closed,
      });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "heading", text: heading[1].trim() });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? "ul" : "ol";
      if (list && list.kind !== kind) flushList();
      list ??= { kind, items: [] };
      list.items.push((bullet ?? numbered)![1].trim());
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

/** `code`, **bold** and *italic* inside a line of text. */
export function Inline({ text }: { text: string }): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
          return (
            <code key={i} className={styles.inlineCode}>
              {p.slice(1, -1)}
            </code>
          );
        }
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
          return <strong key={i}>{p.slice(2, -2)}</strong>;
        }
        if (p.startsWith("*") && p.endsWith("*") && p.length > 2) {
          return <em key={i}>{p.slice(1, -1)}</em>;
        }
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

const KEYWORDS = new Set(
  (
    "select from where join left right inner outer full cross on group by order having limit offset " +
    "insert into values update set delete create alter drop table index view as and or not in is null " +
    "like between exists union all distinct case when then else end with returning primary key " +
    "references foreign default unique asc desc over partition explain analyze begin commit rollback " +
    "match return call yield unwind optional using"
  ).split(" "),
);

type Token = { text: string; kind: "keyword" | "string" | "number" | "comment" | "plain" };

/** A small SQL tokenizer for highlighting code blocks (not a parser). */
export function tokenize(code: string): Token[] {
  const out: Token[] = [];
  const re =
    /(--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|\b\d+(?:\.\d+)?\b|[A-Za-z_][A-Za-z0-9_]*|\s+|.)/g;
  for (const m of code.matchAll(re)) {
    const t = m[0];
    let kind: Token["kind"] = "plain";
    if (t.startsWith("--") || t.startsWith("/*")) kind = "comment";
    else if (t.startsWith("'")) kind = "string";
    else if (/^\d/.test(t)) kind = "number";
    else if (KEYWORDS.has(t.toLowerCase())) kind = "keyword";
    out.push({ text: t, kind });
  }
  return out;
}

export function Highlighted({ code }: { code: string }) {
  return (
    <>
      {tokenize(code).map((t, i) =>
        t.kind === "plain" ? (
          <Fragment key={i}>{t.text}</Fragment>
        ) : (
          <span key={i} className={styles[t.kind]}>
            {t.text}
          </span>
        ),
      )}
    </>
  );
}

export interface CodeActions {
  onCopy: (code: string) => void;
  onInsert?: (code: string) => void;
}

/** An answer as Markdown: paragraphs, lists and code blocks with Copy / Insert at cursor. */
export function Markdown({ text, actions }: { text: string; actions?: CodeActions }) {
  return (
    <>
      {parseBlocks(text).map((b, i) => {
        switch (b.kind) {
          case "p":
            return (
              <p key={i} className={styles.p}>
                <Inline text={b.text} />
              </p>
            );
          case "heading":
            return (
              <p key={i} className={styles.heading}>
                <Inline text={b.text} />
              </p>
            );
          case "ul":
          case "ol": {
            const List = b.kind;
            return (
              <List key={i} className={styles.list}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </List>
            );
          }
          case "code":
            return (
              <div key={i} className={styles.codeBlock} data-lang={b.lang || "sql"}>
                <pre className={styles.code}>
                  <code>
                    {b.lang && b.lang !== "sql" && b.lang !== "cypher" ? (
                      b.text
                    ) : (
                      <Highlighted code={b.text} />
                    )}
                  </code>
                </pre>
                {actions && !b.open ? (
                  <div className={styles.codeActions}>
                    <button type="button" onClick={() => actions.onCopy(b.text)}>
                      Copy
                    </button>
                    {actions.onInsert ? (
                      <button type="button" onClick={() => actions.onInsert?.(b.text)}>
                        Insert at cursor
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
        }
      })}
    </>
  );
}

/**
 * Schema-aware Cypher completion: labels (with their node counts) after `:` in a node pattern,
 * relationship types in `[:`, property keys after `n.` and in `{`, parameters after `$`,
 * procedures after `CALL`, and keywords and functions elsewhere. The pure function
 * `cypherSuggestions` knows nothing of CodeMirror and carries the unit tests.
 */
import { acceptCompletion, autocompletion } from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { formatCount } from "../../explorer/names";
import { isMac } from "../../../lib/platform";
import type { GraphSchema } from "../types";
import { CYPHER_KEYWORDS } from "./language";

export const CYPHER_FUNCTIONS = (
  "abs avg ceil coalesce collect count date datetime duration elementId endNode exists floor head " +
  "id keys labels last left length localdatetime max min nodes point properties randomUUID range " +
  "reduce relationships replace reverse right round shortestPath sign size split sqrt startNode " +
  "substring sum tail timestamp toBoolean toFloat toInteger toLower toString toUpper trim type"
).split(" ");

export const CYPHER_PROCEDURES = [
  "db.labels",
  "db.relationshipTypes",
  "db.propertyKeys",
  "db.indexes",
  "db.constraints",
  "db.schema.visualization",
  "db.schema.nodeTypeProperties",
  "db.schema.relTypeProperties",
  "dbms.components",
  "dbms.procedures",
  "dbms.functions",
];

export interface CypherSuggestions {
  /** Offset in the text the options replace from. */
  from: number;
  options: Completion[];
}

const option = (label: string, type: string, detail?: string, boost = 0): Completion => ({
  label,
  type,
  detail,
  boost,
});

/** The innermost bracket still open at the end of `text`, and where its contents start. */
function innermost(text: string): { open: string; at: number } | null {
  const stack: { open: string; at: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return stack[stack.length - 1] ?? null;
      i = nl;
    } else if (c === "(" || c === "[" || c === "{") stack.push({ open: c, at: i + 1 });
    else if (c === ")" || c === "]" || c === "}") stack.pop();
    i += 1;
  }
  return stack[stack.length - 1] ?? null;
}

/** Whether the cursor sits inside a string or a comment, where nothing is offered. */
function inQuoteOrComment(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) return true;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return true;
      i = nl;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return true;
      i = end + 1;
    }
    i += 1;
  }
  return false;
}

export interface SuggestInput {
  /** The text of the current statement up to the cursor. */
  before: string;
  schema: GraphSchema | null;
  /** Names set in the Parameters panel. */
  params: string[];
  explicit?: boolean;
}

export function cypherSuggestions(input: SuggestInput): CypherSuggestions | null {
  const { before, schema } = input;
  if (inQuoteOrComment(before)) return null;
  const at = (m: RegExpExecArray, group = 1) => before.length - m[group].length;

  const labels = () =>
    (schema?.labels ?? []).map((l) => option(l.name, "class", formatCount(l.count), 10));
  const types = () =>
    (schema?.relationshipTypes ?? []).map((r) =>
      option(r.name, "class", r.count ? formatCount(r.count) : undefined, 10),
    );
  const keys = () => (schema?.propertyKeys ?? []).map((k) => option(k, "property", undefined, 5));

  // `$param`
  const param = /\$([A-Za-z_]\w*)?$/.exec(before);
  if (param) {
    return {
      from: before.length - (param[1]?.length ?? 0),
      options: input.params.map((p) => option(p, "variable", "parameter", 8)),
    };
  }

  const inner = innermost(before);
  const segment = inner ? before.slice(inner.at) : before;

  // Labels and relationship types: `(n:Us`, `(n:User:Pr`, `[r:PUR`, `[:A|B`
  const colon = /:\s*(?:[\w`]+\s*[:|&]\s*)*([\w]*)$/.exec(segment);
  if (colon && inner && (inner.open === "(" || inner.open === "[") && !/\{[^}]*$/.test(segment)) {
    const from = before.length - colon[1].length;
    return { from, options: inner.open === "(" ? labels() : types() };
  }
  // `WHERE n:Us` label predicate outside any bracket
  if (!inner || inner.open === "{") {
    const predicate = /\b[A-Za-z_]\w*\s*:\s*(\w*)$/.exec(segment);
    if (predicate && !inner) return { from: at(predicate), options: labels() };
  }

  // Property keys: inside `{ … }` of a pattern
  if (inner?.open === "{") {
    const key = /(?:^|,)\s*(\w*)$/.exec(segment);
    if (key) return { from: before.length - key[1].length, options: keys() };
    return null;
  }

  // `CALL db.lab`
  const call = /\bCALL\s+([\w.]*)$/i.exec(before);
  if (call) {
    const procedures = schema?.procedures?.length ? schema.procedures : CYPHER_PROCEDURES;
    return {
      from: at(call),
      options: procedures.map((p) => option(p, "function", "procedure", 5)),
    };
  }

  // `n.na`
  const member = /\b[A-Za-z_]\w*\.(\w*)$/.exec(before);
  if (member) return { from: at(member), options: keys() };

  const word = /[\w]*$/.exec(before)?.[0] ?? "";
  if (word === "" && !input.explicit) return null;
  const functions = schema?.functions?.length ? schema.functions : CYPHER_FUNCTIONS;
  return {
    from: before.length - word.length,
    options: [
      ...CYPHER_KEYWORDS.map((k) => option(k, "keyword")),
      ...functions.map((f) => option(f, "function", "function", 1)),
    ],
  };
}

export interface CypherTarget {
  schema: () => GraphSchema | null;
  /** Names of the parameters set in the Parameters panel. */
  params: () => string[];
}

/** The text of the statement the cursor is in, up to the cursor. */
function statementBefore(context: CompletionContext): string {
  const text = context.state.sliceDoc(0, context.pos);
  // statements end at `;` outside strings: a plain scan is enough up to the cursor
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === ";") start = i + 1;
    i += 1;
  }
  return text.slice(start);
}

const ICONS: Record<string, string> = {
  class: "◉",
  property: "▪",
  keyword: "◇",
  function: "ƒ",
  variable: "$",
};

function optionIcon(completion: Completion): Node {
  const el = document.createElement("span");
  el.className = "cm-sqlIcon";
  el.textContent = ICONS[completion.type ?? "keyword"] ?? "◇";
  el.setAttribute("aria-hidden", "true");
  return el;
}

const hint = () => `↵ insert · ⇥ replace · ${isMac() ? "⌃Space" : "Ctrl+Space"} more`;

/** The CodeMirror completion source fed by the live graph schema. */
export function cypherSource(target: CypherTarget) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = statementBefore(context);
    const found = cypherSuggestions({
      before,
      schema: target.schema(),
      params: target.params(),
      explicit: context.explicit,
    });
    if (!found) return null;
    return { from: context.pos - before.length + found.from, options: found.options, filter: true };
  };
}

/** The CodeMirror extension: completion fed by the live graph schema. */
export function cypherCompletion(target: CypherTarget): Extension {
  const source = cypherSource(target);
  return [
    autocompletion({
      override: [source],
      icons: false,
      defaultKeymap: false,
      maxRenderedOptions: 200,
      addToOptions: [{ render: optionIcon, position: 10 }],
    }),
    keymap.of([{ key: "Tab", run: acceptCompletion }]),
    EditorView.theme({
      ".cm-tooltip-autocomplete::after": { content: JSON.stringify(hint()) },
    }),
  ];
}

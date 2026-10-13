/**
 * Cypher syntax highlighting for CodeMirror 6 as a `StreamLanguage`. The `@neo4j-cypher/*`
 * packages are not used (see design.md of `add-graph-browser`): the language-support package is
 * a pre-release of about 130 MB with an ANTLR runtime, which does not fit a desktop bundle.
 *
 * Colours come from the shared highlight style: keywords `--syn-keyword`, labels, relationship
 * types and functions `--syn-function`, strings, numbers and comments as in the SQL editor.
 */
import { StreamLanguage } from "@codemirror/language";
import type { StringStream } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

export const CYPHER_KEYWORDS = (
  "ALL AND AS ASC ASCENDING BY CALL CASE COMMIT CONSTRAINT CONTAINS CREATE CSV DATABASE DATABASES " +
  "DELETE DESC DESCENDING DETACH DISTINCT DROP ELSE END ENDS EXISTS EXPLAIN FIELDTERMINATOR FOREACH " +
  "FOR FROM HEADERS IN INDEX IS LIMIT LOAD MATCH MERGE NOT ON OPTIONAL OR ORDER PERIODIC PROFILE " +
  "REMOVE REQUIRE RETURN SET SHOW SKIP STARTS TERMINATE THEN TRANSACTIONS UNION UNIQUE UNWIND USE " +
  "USING WHEN WHERE WITH XOR YIELD"
).split(" ");

const KEYWORD_SET = new Set(CYPHER_KEYWORDS);
/** Words that are keywords on their own and functions when a `(` follows. */
const FUNCTION_LIKE = new Set(["ALL", "ANY", "NONE", "SINGLE", "EXISTS"]);
const ATOMS = new Set(["TRUE", "FALSE", "NULL"]);

interface CypherState {
  /** Open `(`, `[` and `{`; a `:` inside `(`/`[` introduces labels and types. */
  stack: string[];
  /** The next identifier is a label or relationship type. */
  label: boolean;
  /** Inside a block comment. */
  block: boolean;
  /** The previous token was a label: `|` and `&` continue the label expression. */
  afterLabel?: boolean;
}

function quoted(stream: StringStream, quote: string): void {
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === "\\") stream.next();
    else if (ch === quote) return;
  }
}

const IDENT = /[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*/;

const startState = (): CypherState => ({ stack: [], label: false, block: false });
const copyState = (s: CypherState): CypherState => ({ ...s, stack: [...s.stack] });

/** The tokenizer; exported for tests. */
export function token(stream: StringStream, state: CypherState): string | null {
  if (state.block) {
    if (stream.skipTo("*/")) {
      stream.match("*/");
      state.block = false;
    } else stream.skipToEnd();
    return "blockComment";
  }
  if (stream.eatSpace()) return null;
  const afterLabel = state.afterLabel === true;
  state.afterLabel = false;
  if (stream.match("//")) {
    stream.skipToEnd();
    return "lineComment";
  }
  if (stream.match("/*")) {
    state.block = true;
    return token(stream, state);
  }
  const ch = stream.peek() ?? "";
  if (ch === "'" || ch === '"') {
    stream.next();
    quoted(stream, ch);
    state.label = false;
    return "string";
  }
  if (ch === "`") {
    stream.next();
    quoted(stream, "`");
    const wasLabel = state.label;
    state.label = false;
    return wasLabel ? "typeName" : "variableName";
  }
  if (ch === "$") {
    stream.next();
    if (!stream.match(IDENT)) stream.match(/\d+/);
    return "variableName.special";
  }
  if (/\d/.test(ch) || (ch === "." && /\d/.test(stream.string.charAt(stream.pos + 1)))) {
    if (!stream.match(/0[xX][0-9a-fA-F]+|0[0-7]+(?![.\d])/)) {
      stream.match(/\d*\.?\d+(?:[eE][+-]?\d+)?/);
    }
    state.label = false;
    return "number";
  }
  if (/[([{]/.test(ch)) {
    stream.next();
    state.stack.push(ch);
    state.label = false;
    return "paren";
  }
  if (/[)\]}]/.test(ch)) {
    stream.next();
    state.stack.pop();
    state.label = false;
    return "paren";
  }
  if (ch === ":") {
    stream.next();
    const top = state.stack[state.stack.length - 1];
    state.label = top === "(" || top === "[";
    return "punctuation";
  }
  if ((ch === "|" || ch === "&") && afterLabel) {
    stream.next();
    state.label = true;
    return "punctuation";
  }
  if (ch === "!" && state.label) {
    stream.next();
    return "punctuation";
  }
  if (stream.match(IDENT)) {
    const word = stream.current();
    const upper = word.toUpperCase();
    const wasLabel = state.label;
    state.label = false;
    if (wasLabel) {
      // `:A:B`, `:A|B`, `:A&B` keep naming labels
      state.afterLabel = true;
      return "typeName";
    }
    const call = stream.match(/\s*\(/, false) !== null;
    if (ATOMS.has(upper)) return "bool";
    if (KEYWORD_SET.has(upper) && !(call && FUNCTION_LIKE.has(upper))) return "keyword";
    if (call) return "function";
    return "variableName";
  }
  stream.next();
  state.label = false;
  return "operator";
}

const tokenTable = {
  lineComment: t.lineComment,
  blockComment: t.blockComment,
  string: t.string,
  number: t.number,
  bool: t.bool,
  keyword: t.keyword,
  typeName: t.typeName,
  variableName: t.variableName,
  "variableName.special": t.special(t.variableName),
  function: t.function(t.variableName),
  punctuation: t.punctuation,
  paren: t.paren,
  operator: t.operator,
};

/** Cypher language support (highlighting only; completion is a separate extension). */
export function cypherLanguage(): Extension {
  return StreamLanguage.define<CypherState>({
    name: "cypher",
    startState,
    copyState,
    token,
    tokenTable,
    languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
  });
}

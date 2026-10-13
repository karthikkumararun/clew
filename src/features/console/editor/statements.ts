/**
 * Statement detection for the editor. This is a TypeScript port of `src-tauri/src/drivers/split.rs`
 * (same rules for quotes, comments, dollar quoting, `BEGIN … END` and MySQL `DELIMITER`); both are
 * tested against the shared fixtures in `src-tauri/tests/fixtures/split/`.
 *
 * Offsets are UTF-16 code units, as CodeMirror uses. The editor additionally treats a blank line
 * as a statement boundary (`blankLines`), which the server-side script splitter does not.
 */

export type SplitDialect =
  | "postgresql"
  | "mysql"
  | "mariadb"
  | "sqlite"
  | "tsql"
  | "oracle"
  /** One command per line (Redis); `#` starts a comment line. */
  | "lines"
  /** Cypher: `//` comments (`--` is a relationship), backslash escapes, backtick names. */
  | "cypher"
  | null;

export interface StatementRange {
  /** Statement text without its delimiter, trimmed. */
  text: string;
  from: number;
  to: number;
}

export interface SplitOptions {
  /** Also end a statement at a blank line (an editor convenience for scripts without `;`). */
  blankLines?: boolean;
  /** Start each statement at its first token, leaving comments above it out (the editor tint). */
  skipLeadingComments?: boolean;
}

const isWs = (c: number) => c === 32 || (c >= 9 && c <= 13);
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isIdentStart = (c: number) => isAlpha(c) || c === 95 || c >= 0x80;
const isIdentChar = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57) || c === 36;

const QUOTE = 39; // '
const DQUOTE = 34; // "
const BACKTICK = 96;
const DASH = 45;
const HASH = 35;
const SLASH = 47;
const STAR = 42;
const DOLLAR = 36;
const NEWLINE = 10;

/** A line that is only `GO` (optionally `GO 5` and a comment). */
function isGoLine(line: string): boolean {
  const t = line.trim();
  if (!/^go/i.test(t)) return false;
  const rest = t.slice(2).trimStart().split("--")[0].trim();
  return rest === "" || /^\d+$/.test(rest);
}

/** Split at the lines `isSep` accepts, ignoring those inside strings and block comments. */
function splitAtLines(sql: string, isSep: (line: string) => boolean): StatementRange[] {
  const out: StatementRange[] = [];
  let batchStart = 0;
  let offset = 0;
  let inBlock = false;
  let inString = false;
  const push = (from: number, to: number) => {
    const raw = sql.slice(from, to);
    const text = raw.trim();
    if (!text) return;
    const start = from + (raw.length - raw.trimStart().length);
    out.push({ text, from: start, to: start + text.length });
  };
  for (const line of sql.split(/(?<=\n)/)) {
    const content = line.replace(/[\r\n]+$/, "");
    if (!inBlock && !inString && isSep(content)) {
      push(batchStart, offset);
      batchStart = offset + line.length;
    }
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (inBlock) {
        if (c === "*" && content[i + 1] === "/") {
          inBlock = false;
          i++;
        }
      } else if (inString) {
        if (c === "'") {
          if (content[i + 1] === "'") i++;
          else inString = false;
        }
      } else if (c === "-" && content[i + 1] === "-") {
        break;
      } else if (c === "/" && content[i + 1] === "*") {
        inBlock = true;
        i++;
      } else if (c === "'") {
        inString = true;
      }
    }
    offset += line.length;
  }
  push(batchStart, sql.length);
  return out;
}

const splitGo = (sql: string) => splitAtLines(sql, isGoLine);

/** Does a segment define or run a PL/SQL unit? Those are ended by a `/` line, not semicolons. */
function isPlsqlUnit(segment: string): boolean {
  const words = segment
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((w) => w.toUpperCase());
  if (words[0] === "BEGIN" || words[0] === "DECLARE") return true;
  return (
    words[0] === "CREATE" &&
    words.slice(1).some((w) => ["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE"].includes(w))
  );
}

/** Oracle: a `/` line ends what came before; a PL/SQL unit runs to it, other statements to `;`. */
function splitOracle(sql: string, options: SplitOptions): StatementRange[] {
  const out: StatementRange[] = [];
  for (const segment of splitAtLines(sql, (line) => line.trim() === "/")) {
    for (const inner of splitStatements(segment.text, null, options)) {
      if (isPlsqlUnit(inner.text)) {
        out.push({
          text: segment.text.slice(inner.from).trimEnd(),
          from: segment.from + inner.from,
          to: segment.to,
        });
        break;
      }
      out.push({ text: inner.text, from: segment.from + inner.from, to: segment.from + inner.to });
    }
  }
  return out;
}

/** Variables live in their batch, and blocks and modules hold semicolons that end nothing. */
function keepsTogether(batch: string): boolean {
  if (batch.includes("@")) return true;
  const words = batch
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
  const first = words[0] ?? "";
  return (
    first === "CREATE" || first === "ALTER" || first === "BEGIN" || words.slice(1).includes("BEGIN")
  );
}

function splitTsql(sql: string, options: SplitOptions): StatementRange[] {
  const out: StatementRange[] = [];
  for (const batch of splitGo(sql)) {
    if (keepsTogether(batch.text)) {
      out.push(batch);
      continue;
    }
    for (const inner of splitStatements(batch.text, null, options)) {
      out.push({ text: inner.text, from: batch.from + inner.from, to: batch.from + inner.to });
    }
  }
  return out;
}

/** Redis: every non-blank line that isn't a `#` comment is a command. */
function splitCommandLines(sql: string): StatementRange[] {
  const out: StatementRange[] = [];
  let offset = 0;
  for (const line of sql.split("\n")) {
    const text = line.trim();
    if (text && !text.startsWith("#")) {
      const from = offset + (line.length - line.trimStart().length);
      out.push({ text, from, to: from + text.length });
    }
    offset += line.length + 1;
  }
  return out;
}

export function splitStatements(
  sql: string,
  dialect: SplitDialect,
  options: SplitOptions = {},
): StatementRange[] {
  if (dialect === "lines") return splitCommandLines(sql);
  if (dialect === "tsql") return splitTsql(sql, options);
  if (dialect === "oracle") return splitOracle(sql, options);
  const n = sql.length;
  const mysql = dialect === "mysql" || dialect === "mariadb";
  const postgres = dialect === "postgresql";
  const cypher = dialect === "cypher";
  const out: StatementRange[] = [];

  const code = (i: number) => sql.charCodeAt(i);

  const skipQuoted = (i: number, quote: number, backslash: boolean): number => {
    let j = i + 1;
    while (j < n) {
      const c = code(j);
      if (backslash && c === 92) {
        j += 2;
        continue;
      }
      if (c === quote) {
        if (code(j + 1) === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j += 1;
    }
    return n;
  };

  const skipLine = (i: number): number => {
    const p = sql.indexOf("\n", i);
    return p < 0 ? n : p + 1;
  };

  const skipBlockComment = (i: number): number => {
    let depth = 1;
    let j = i + 2;
    while (j < n) {
      if (postgres && code(j) === SLASH && code(j + 1) === STAR) {
        depth += 1;
        j += 2;
      } else if (code(j) === STAR && code(j + 1) === SLASH) {
        depth -= 1;
        j += 2;
        if (depth === 0) return j;
      } else {
        j += 1;
      }
    }
    return n;
  };

  const isLineCommentStart = (i: number): boolean => {
    const c = code(i);
    if (cypher) return c === SLASH && code(i + 1) === SLASH;
    if (c === DASH && code(i + 1) === DASH) {
      // MySQL requires whitespace (or the end) after `--`.
      if (!mysql) return true;
      return i + 2 >= n || isWs(code(i + 2)) || code(i + 2) < 32;
    }
    return c === HASH && mysql;
  };

  const dollarTag = (i: number): string | null => {
    if (!postgres || code(i) !== DOLLAR) return null;
    if (i > 0 && isIdentChar(code(i - 1))) return null;
    let j = i + 1;
    if (j < n && isIdentStart(code(j)) && code(j) < 0x80) {
      while (j < n && isIdentChar(code(j)) && code(j) !== DOLLAR) j += 1;
    }
    return code(j) === DOLLAR ? sql.slice(i, j + 1) : null;
  };

  const wordAt = (i: number): [string, number] => {
    let j = i;
    while (j < n && isIdentChar(code(j))) j += 1;
    return [sql.slice(i, j), j];
  };

  const peekWord = (from: number): string | null => {
    let i = from;
    while (i < n && isWs(code(i))) i += 1;
    return i < n && isIdentStart(code(i)) ? wordAt(i)[0] : null;
  };

  let delimiter = ";";
  let segStart = 0;
  let hasContent = false;
  let depth = 0;
  let wordsInStmt = 0;
  let prevWord = "";
  let i = 0;

  /** Index of the first character after whitespace and comments at or after `i`. */
  const skipTrivia = (i: number, end: number): number => {
    let j = i;
    while (j < end) {
      if (isWs(code(j))) j += 1;
      else if (isLineCommentStart(j)) j = skipLine(j);
      else if (code(j) === SLASH && code(j + 1) === STAR) j = skipBlockComment(j);
      else break;
    }
    return Math.min(j, end);
  };

  const flush = (from: number, to: number) => {
    if (options.skipLeadingComments) {
      from = skipTrivia(from, to);
      if (from >= to) return;
    }
    const raw = sql.slice(from, to);
    const text = raw.trim();
    if (text === "") return;
    const lead = raw.length - raw.trimStart().length;
    out.push({ text, from: from + lead, to: from + lead + text.length });
  };

  const reset = () => {
    hasContent = false;
    wordsInStmt = 0;
    prevWord = "";
  };

  while (i < n) {
    const c = code(i);

    // A blank line ends a statement (editor only).
    if (options.blankLines && c === NEWLINE && hasContent && depth === 0) {
      let j = i + 1;
      while (j < n && (code(j) === 32 || code(j) === 9 || code(j) === 13)) j += 1;
      if (j >= n || code(j) === NEWLINE) {
        flush(segStart, i);
        i = j;
        segStart = i;
        reset();
        continue;
      }
    }

    if (isWs(c)) {
      i += 1;
      continue;
    }

    // MySQL client command at the start of a statement.
    if (mysql && !hasContent && isAlpha(c)) {
      const [w, end] = wordAt(i);
      if (w.toLowerCase() === "delimiter" && (code(end) === 32 || code(end) === 9)) {
        const lineEnd = skipLine(end);
        const arg = sql.slice(end, lineEnd).trim();
        if (arg) delimiter = arg;
        i = lineEnd;
        segStart = i;
        continue;
      }
    }

    if (isLineCommentStart(i)) {
      i = skipLine(i);
      continue;
    }
    if (c === SLASH && code(i + 1) === STAR) {
      i = skipBlockComment(i);
      continue;
    }

    // A delimiter inside a BEGIN … END block belongs to the block.
    if (depth === 0 && sql.startsWith(delimiter, i)) {
      flush(segStart, i);
      i += delimiter.length;
      segStart = i;
      reset();
      continue;
    }

    hasContent = true;

    if (c === QUOTE) {
      const backslash =
        mysql ||
        cypher ||
        (postgres &&
          i > 0 &&
          (code(i - 1) === 101 || code(i - 1) === 69) &&
          (i < 2 || !isIdentChar(code(i - 2))));
      i = skipQuoted(i, QUOTE, backslash);
    } else if (c === DQUOTE) {
      i = skipQuoted(i, DQUOTE, mysql || cypher);
    } else if (c === BACKTICK && (mysql || cypher)) {
      i = skipQuoted(i, BACKTICK, false);
    } else if (c === DOLLAR) {
      const tag = dollarTag(i);
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close < 0 ? n : close + tag.length;
      } else {
        i += 1;
      }
    } else if (isIdentStart(c)) {
      const [word, end] = wordAt(i);
      const upper = word.toUpperCase();
      if (upper === "BEGIN" && wordsInStmt > 0) {
        depth += 1;
      } else if (upper === "CASE" && prevWord !== "END") {
        depth += 1;
      } else if (upper === "END" && depth > 0) {
        const next = peekWord(end)?.toUpperCase();
        const closesOther =
          next === "IF" || next === "LOOP" || next === "WHILE" || next === "REPEAT";
        if (!closesOther) depth -= 1;
      }
      wordsInStmt += 1;
      prevWord = upper;
      i = end;
    } else {
      i += 1;
    }
  }

  if (hasContent) flush(segStart, n);
  return out;
}

/**
 * The statement the cursor belongs to: one that contains `pos`, counting the delimiter right
 * after it. Whitespace between statements belongs to none.
 */
export function statementAt(ranges: StatementRange[], pos: number): StatementRange | null {
  for (const r of ranges) {
    if (pos >= r.from && pos <= r.to + 1) return r;
    if (r.from > pos) break;
  }
  return null;
}

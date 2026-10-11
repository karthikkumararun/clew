//! Dialect-aware statement splitter for script mode.
//!
//! Handles quotes, dollar quoting (PostgreSQL), comments, `BEGIN … END` blocks and MySQL's
//! `DELIMITER` command. The fixture corpus in `tests/fixtures/split/` is shared with the
//! frontend's "current statement" logic so the two stay in sync.

use super::Dialect;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    /// The statement text without its terminating delimiter, trimmed of whitespace.
    pub text: String,
    /// Byte offset of the first character of `text` in the input.
    pub start: usize,
    /// Byte offset just past the last character of `text`.
    pub end: usize,
}

struct Scanner<'a> {
    src: &'a str,
    b: &'a [u8],
    dialect: Option<Dialect>,
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c >= 0x80
}

fn is_ident_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
}

impl<'a> Scanner<'a> {
    fn mysql(&self) -> bool {
        matches!(self.dialect, Some(Dialect::Mysql | Dialect::Mariadb))
    }

    fn postgres(&self) -> bool {
        matches!(self.dialect, Some(Dialect::Postgresql | Dialect::Duckdb))
    }

    /// Index just past a quoted run starting at `i` (which holds the opening quote).
    fn skip_quoted(&self, i: usize, quote: u8, backslash: bool) -> usize {
        let mut j = i + 1;
        while j < self.b.len() {
            let c = self.b[j];
            if backslash && c == b'\\' {
                j += 2;
                continue;
            }
            if c == quote {
                if self.b.get(j + 1) == Some(&quote) {
                    j += 2;
                    continue;
                }
                return j + 1;
            }
            j += 1;
        }
        self.b.len()
    }

    /// Index just past a `--`/`#` line comment starting at `i`.
    fn skip_line(&self, i: usize) -> usize {
        self.b[i..]
            .iter()
            .position(|&c| c == b'\n')
            .map_or(self.b.len(), |p| i + p + 1)
    }

    /// Index just past a block comment starting at `i` (nesting is a PostgreSQL feature).
    fn skip_block_comment(&self, i: usize) -> usize {
        let nest = self.postgres();
        let mut depth = 1;
        let mut j = i + 2;
        while j < self.b.len() {
            if nest && self.b[j] == b'/' && self.b.get(j + 1) == Some(&b'*') {
                depth += 1;
                j += 2;
            } else if self.b[j] == b'*' && self.b.get(j + 1) == Some(&b'/') {
                depth -= 1;
                j += 2;
                if depth == 0 {
                    return j;
                }
            } else {
                j += 1;
            }
        }
        self.b.len()
    }

    fn is_line_comment_start(&self, i: usize) -> bool {
        match self.b[i] {
            b'-' if self.b.get(i + 1) == Some(&b'-') => {
                // MySQL requires whitespace (or end of input) after `--`.
                !self.mysql()
                    || self
                        .b
                        .get(i + 2)
                        .map_or(true, |c| c.is_ascii_whitespace() || c.is_ascii_control())
            }
            b'#' => self.mysql(),
            _ => false,
        }
    }

    /// If a dollar-quote tag opens at `i`, return the whole `$tag$` (as bytes) and its length.
    fn dollar_tag(&self, i: usize) -> Option<&'a [u8]> {
        if !self.postgres() || self.b[i] != b'$' {
            return None;
        }
        if i > 0 && is_ident_char(self.b[i - 1]) {
            return None;
        }
        let mut j = i + 1;
        if j < self.b.len() && is_ident_start(self.b[j]) && self.b[j] < 0x80 {
            while j < self.b.len() && is_ident_char(self.b[j]) && self.b[j] != b'$' {
                j += 1;
            }
        }
        (self.b.get(j) == Some(&b'$')).then(|| &self.b[i..=j])
    }

    fn skip_dollar_quoted(&self, i: usize, tag: &[u8]) -> usize {
        let from = i + tag.len();
        self.b[from..]
            .windows(tag.len())
            .position(|w| w == tag)
            .map_or(self.b.len(), |p| from + p + tag.len())
    }

    fn word_at(&self, i: usize) -> (&'a str, usize) {
        let mut j = i;
        while j < self.b.len() && is_ident_char(self.b[j]) {
            j += 1;
        }
        (&self.src[i..j], j)
    }

    /// The next word after `i`, skipping whitespace (not comments; good enough for END IF).
    fn peek_word(&self, mut i: usize) -> Option<&'a str> {
        while i < self.b.len() && self.b[i].is_ascii_whitespace() {
            i += 1;
        }
        (i < self.b.len() && is_ident_start(self.b[i])).then(|| self.word_at(i).0)
    }
}

/// T-SQL scripts are separated by `GO` lines, not semicolons: a batch keeps its variables, its
/// blocks and its several statements together. `GO` (optionally `GO 5` and a trailing comment)
/// counts only on a line of its own, outside strings and block comments.
fn split_go(sql: &str) -> Vec<Statement> {
    split_at_lines(sql, is_go_line)
}

/// Split at the lines `is_sep` accepts, ignoring those inside strings and block comments.
fn split_at_lines(sql: &str, is_sep: fn(&str) -> bool) -> Vec<Statement> {
    let mut out = Vec::new();
    let (mut batch_start, mut offset) = (0usize, 0usize);
    let (mut in_block, mut in_string) = (false, false);
    let push = |from: usize, to: usize, out: &mut Vec<Statement>| {
        let raw = &sql[from..to];
        let text = raw.trim();
        if !text.is_empty() {
            let start = from + (raw.len() - raw.trim_start().len());
            out.push(Statement {
                text: text.to_string(),
                start,
                end: start + text.len(),
            });
        }
    };
    for line in sql.split_inclusive('\n') {
        let content = line.trim_end_matches(['\n', '\r']);
        if !in_block && !in_string && is_sep(content) {
            push(batch_start, offset, &mut out);
            batch_start = offset + line.len();
        }
        // Track what a line leaves open, for the next one.
        let b = content.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if in_block {
                if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                    in_block = false;
                    i += 1;
                }
            } else if in_string {
                if b[i] == b'\'' {
                    if b.get(i + 1) == Some(&b'\'') {
                        i += 1;
                    } else {
                        in_string = false;
                    }
                }
            } else if b[i] == b'-' && b.get(i + 1) == Some(&b'-') {
                break;
            } else if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                in_block = true;
                i += 1;
            } else if b[i] == b'\'' {
                in_string = true;
            }
            i += 1;
        }
        offset += line.len();
    }
    push(batch_start, sql.len(), &mut out);
    out
}

/// Does a batch have to run as one unit? Variables live only inside their batch, and blocks and
/// module definitions contain semicolons that don't end anything.
fn keeps_together(batch: &str) -> bool {
    if batch.contains('@') {
        return true;
    }
    let mut words = batch
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_uppercase);
    let first = words.next().unwrap_or_default();
    first == "CREATE" || first == "ALTER" || first == "BEGIN" || words.any(|w| w == "BEGIN")
}

/// `GO` batches; inside one, plain statements are still separated at semicolons (so
/// `SELECT 1; SELECT 2` shows two results) unless the batch needs to stay whole.
fn split_tsql(sql: &str) -> Vec<Statement> {
    let mut out = Vec::new();
    for batch in split_go(sql) {
        if keeps_together(&batch.text) {
            out.push(batch);
            continue;
        }
        for inner in split(&batch.text, None) {
            out.push(Statement {
                start: batch.start + inner.start,
                end: batch.start + inner.end,
                text: inner.text,
            });
        }
    }
    out
}

/// Does a segment define or run a PL/SQL unit? Those contain semicolons that end nothing and are
/// ended by a `/` line instead.
fn is_plsql_unit(segment: &str) -> bool {
    let words: Vec<String> = segment
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty())
        .take(6)
        .map(str::to_ascii_uppercase)
        .collect();
    match words.first().map(String::as_str) {
        Some("BEGIN" | "DECLARE") => true,
        Some("CREATE") => words.iter().skip(1).any(|w| {
            matches!(
                w.as_str(),
                "PROCEDURE" | "FUNCTION" | "PACKAGE" | "TRIGGER" | "TYPE"
            )
        }),
        _ => false,
    }
}

/// Oracle scripts: a line holding only `/` ends whatever came before it (SQL*Plus style); PL/SQL
/// blocks and program units are ended only by that line, other statements also by semicolons.
fn split_oracle(sql: &str) -> Vec<Statement> {
    let mut out = Vec::new();
    for segment in split_at_lines(sql, |line| line.trim() == "/") {
        for inner in split(&segment.text, None) {
            // From the first PL/SQL unit to the `/` it is one statement, semicolons and all.
            if is_plsql_unit(&inner.text) {
                let start = segment.start + inner.start;
                out.push(Statement {
                    text: segment.text[inner.start..].trim_end().to_string(),
                    start,
                    end: segment.end,
                });
                break;
            }
            out.push(Statement {
                start: segment.start + inner.start,
                end: segment.start + inner.end,
                text: inner.text,
            });
        }
    }
    out
}

fn is_go_line(line: &str) -> bool {
    let t = line.trim();
    let Some(rest) = t
        .get(..2)
        .filter(|h| h.eq_ignore_ascii_case("go"))
        .map(|_| &t[2..])
    else {
        return false;
    };
    let rest = rest.trim_start();
    let rest = rest.split("--").next().unwrap_or("").trim();
    rest.is_empty() || rest.chars().all(|c| c.is_ascii_digit())
}

pub fn split(sql: &str, dialect: Option<Dialect>) -> Vec<Statement> {
    match dialect {
        Some(Dialect::Tsql) => return split_tsql(sql),
        Some(Dialect::Oracle) => return split_oracle(sql),
        _ => {}
    }
    let sc = Scanner {
        src: sql,
        b: sql.as_bytes(),
        dialect,
    };
    let b = sc.b;
    let mut out = Vec::new();

    let mut delimiter: Vec<u8> = b";".to_vec();
    let mut seg_start = 0; // start of the current raw segment
    let mut has_content = false; // saw anything other than whitespace/comments
    let mut depth: i32 = 0; // BEGIN/CASE nesting; resets with each statement
    let mut words_in_stmt = 0;
    let mut prev_word_upper = String::new();
    let mut i = 0;

    let flush = |out: &mut Vec<Statement>, from: usize, to: usize| {
        let raw = &sql[from..to];
        let trimmed_start = raw.len() - raw.trim_start().len();
        let text = raw.trim();
        if text.is_empty() {
            return;
        }
        out.push(Statement {
            text: text.to_string(),
            start: from + trimmed_start,
            end: from + trimmed_start + text.len(),
        });
    };

    while i < b.len() {
        let c = b[i];

        // whitespace
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }

        // MySQL client command at the start of a statement.
        if sc.mysql() && !has_content && c.is_ascii_alphabetic() {
            let (w, end) = sc.word_at(i);
            if w.eq_ignore_ascii_case("delimiter")
                && b.get(end).is_some_and(|c| *c == b' ' || *c == b'\t')
            {
                let line_end = sc.skip_line(end);
                let arg = sql[end..line_end].trim();
                if !arg.is_empty() {
                    delimiter = arg.as_bytes().to_vec();
                }
                i = line_end;
                seg_start = i;
                continue;
            }
        }

        // comments
        if sc.is_line_comment_start(i) {
            i = sc.skip_line(i);
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i = sc.skip_block_comment(i);
            continue;
        }

        // statement delimiter (a delimiter inside a BEGIN … END block belongs to the block)
        if depth == 0 && b[i..].starts_with(&delimiter) {
            flush(&mut out, seg_start, i);
            i += delimiter.len();
            seg_start = i;
            has_content = false;
            words_in_stmt = 0;
            prev_word_upper.clear();
            continue;
        }

        has_content = true;

        match c {
            b'\'' => {
                let backslash = sc.mysql()
                    || (sc.postgres()
                        && i > 0
                        && matches!(b[i - 1], b'e' | b'E')
                        && (i < 2 || !is_ident_char(b[i - 2])));
                i = sc.skip_quoted(i, b'\'', backslash);
            }
            b'"' => i = sc.skip_quoted(i, b'"', sc.mysql()),
            b'`' if sc.mysql() => i = sc.skip_quoted(i, b'`', false),
            b'$' => match sc.dollar_tag(i) {
                Some(tag) => i = sc.skip_dollar_quoted(i, tag),
                None => i += 1,
            },
            _ if is_ident_start(c) => {
                let (word, end) = sc.word_at(i);
                let upper = word.to_ascii_uppercase();
                match upper.as_str() {
                    // `BEGIN;` / `BEGIN TRANSACTION` as a statement's first word is not a block.
                    "BEGIN" if words_in_stmt > 0 => depth += 1,
                    "CASE" if prev_word_upper != "END" => depth += 1,
                    "END" if depth > 0 => {
                        let next = sc.peek_word(end).map(str::to_ascii_uppercase);
                        let closes_other =
                            matches!(next.as_deref(), Some("IF" | "LOOP" | "WHILE" | "REPEAT"));
                        if !closes_other {
                            depth -= 1;
                        }
                    }
                    _ => {}
                }
                words_in_stmt += 1;
                prev_word_upper = upper;
                i = end;
            }
            _ => i += 1,
        }
    }

    if has_content {
        flush(&mut out, seg_start, b.len());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::fs;
    use std::path::PathBuf;

    fn texts(sql: &str, d: Option<Dialect>) -> Vec<String> {
        split(sql, d).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn splits_simple_statements() {
        assert_eq!(texts("select 1; select 2;", None), ["select 1", "select 2"]);
    }

    #[test]
    fn last_statement_needs_no_delimiter() {
        assert_eq!(texts("select 1; select 2", None), ["select 1", "select 2"]);
    }

    #[test]
    fn empty_and_comment_only_input_yields_nothing() {
        assert!(texts("", None).is_empty());
        assert!(texts("  ;;  ; ", None).is_empty());
        assert!(texts("-- nothing here\n/* nor here */", None).is_empty());
    }

    #[test]
    fn offsets_point_at_the_statement_text() {
        let sql = "  select 1;\n  select 2 ;";
        for s in split(sql, None) {
            assert_eq!(&sql[s.start..s.end], s.text);
        }
    }

    #[test]
    fn semicolons_in_strings_and_comments_do_not_split() {
        let sql = "select 'a;b'; -- x; y\nselect \"c;d\" /* e; f */";
        assert_eq!(texts(sql, None).len(), 2);
    }

    #[test]
    fn doubled_quotes_are_escapes() {
        assert_eq!(texts("select 'it''s; fine'; select 2", None).len(), 2);
    }

    #[test]
    fn postgres_dollar_quoting() {
        let sql = "create function f() returns int as $$ begin return 1; end; $$ language plpgsql; select f();";
        assert_eq!(texts(sql, Some(Dialect::Postgresql)).len(), 2);
        let tagged = "do $body$ begin perform 1; end $body$; select 2";
        assert_eq!(texts(tagged, Some(Dialect::Postgresql)).len(), 2);
    }

    #[test]
    fn dollar_signs_outside_postgres_are_ordinary() {
        assert_eq!(
            texts("select $$a$$; select 2", Some(Dialect::Mysql)).len(),
            2
        );
    }

    #[test]
    fn positional_parameters_are_not_dollar_quotes() {
        let sql = "select $1; select $2";
        assert_eq!(
            texts(sql, Some(Dialect::Postgresql)),
            ["select $1", "select $2"]
        );
    }

    #[test]
    fn postgres_nested_block_comments() {
        let sql = "select 1 /* a /* b; */ c; */; select 2";
        assert_eq!(texts(sql, Some(Dialect::Postgresql)).len(), 2);
    }

    #[test]
    fn postgres_escape_strings_honour_backslash() {
        let sql = r"select E'it\'s; ok'; select 2";
        assert_eq!(texts(sql, Some(Dialect::Postgresql)).len(), 2);
    }

    #[test]
    fn mysql_backslash_escapes_and_hash_comments() {
        let sql = "select 'a\\';b'; # c; d\nselect 2";
        assert_eq!(texts(sql, Some(Dialect::Mysql)).len(), 2);
    }

    #[test]
    fn mysql_double_dash_needs_a_space() {
        // `--1` is minus minus one in MySQL, not a comment.
        let sql = "select 2--1; select 3";
        assert_eq!(texts(sql, Some(Dialect::Mysql)).len(), 2);
    }

    #[test]
    fn begin_end_blocks_keep_inner_semicolons() {
        let sql = "create trigger t after insert on a begin insert into b values (1); update c set x = 1; end; select 1";
        let got = texts(sql, Some(Dialect::Sqlite));
        assert_eq!(got.len(), 2);
        assert!(got[0].ends_with("end"));
    }

    #[test]
    fn transaction_begin_is_not_a_block() {
        assert_eq!(
            texts("begin; select 1; commit;", Some(Dialect::Postgresql)).len(),
            3
        );
        assert_eq!(
            texts("BEGIN TRANSACTION; select 1; END;", Some(Dialect::Sqlite)).len(),
            3
        );
    }

    #[test]
    fn case_expressions_inside_blocks() {
        let sql = "create trigger t after insert on a begin update b set x = case when 1 then 2 else 3 end; end; select 1";
        assert_eq!(texts(sql, Some(Dialect::Sqlite)).len(), 2);
    }

    #[test]
    fn end_if_does_not_close_a_block() {
        let sql = "create procedure p() begin if 1 then select 1; end if; select 2; end; select 3";
        assert_eq!(texts(sql, Some(Dialect::Mysql)).len(), 2);
    }

    #[test]
    fn mysql_delimiter_command() {
        let sql = "delimiter //\ncreate procedure p() begin select 1; select 2; end//\ndelimiter ;\nselect 3;";
        let got = texts(sql, Some(Dialect::Mysql));
        assert_eq!(got.len(), 2);
        assert!(got[0].starts_with("create procedure"));
        assert_eq!(got[1], "select 3");
    }

    #[test]
    fn unterminated_quote_swallows_the_rest_without_panicking() {
        assert_eq!(texts("select 'oops; select 2", None).len(), 1);
    }

    #[test]
    fn multibyte_text_is_safe() {
        assert_eq!(texts("select 'é;ü'; select 'ß'", None).len(), 2);
    }

    // ---- shared fixture corpus ----------------------------------------------------------------

    #[derive(Deserialize)]
    struct Expected {
        dialect: Option<String>,
        statements: Vec<String>,
    }

    fn dialect_of(name: Option<&str>) -> Option<Dialect> {
        match name {
            Some("postgresql") => Some(Dialect::Postgresql),
            Some("mysql") => Some(Dialect::Mysql),
            Some("mariadb") => Some(Dialect::Mariadb),
            Some("sqlite") => Some(Dialect::Sqlite),
            Some("tsql") => Some(Dialect::Tsql),
            Some("oracle") => Some(Dialect::Oracle),
            _ => None,
        }
    }

    #[test]
    fn fixture_corpus() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/split");
        let mut checked = 0;
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("sql") {
                continue;
            }
            let sql = fs::read_to_string(&path).unwrap();
            let expected: Expected = serde_json::from_str(
                &fs::read_to_string(path.with_extension("expected.json")).unwrap(),
            )
            .unwrap();
            let got = texts(&sql, dialect_of(expected.dialect.as_deref()));
            assert_eq!(got, expected.statements, "fixture {}", path.display());
            checked += 1;
        }
        assert!(
            checked >= 6,
            "expected a corpus of fixtures, found {checked}"
        );
    }

    #[test]
    fn tsql_batches_without_variables_still_split_at_semicolons() {
        let t = texts("SELECT 1; SELECT 2;\nGO\nSELECT 3", Some(Dialect::Tsql));
        assert_eq!(t, ["SELECT 1", "SELECT 2", "SELECT 3"]);
    }

    #[test]
    fn tsql_blocks_and_modules_stay_whole() {
        let sql = "CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END\nGO\nBEGIN TRY SELECT 1; END TRY BEGIN CATCH SELECT 2; END CATCH";
        let t = texts(sql, Some(Dialect::Tsql));
        assert_eq!(t.len(), 2, "{t:?}");
        assert!(t[0].starts_with("CREATE PROCEDURE") && t[0].ends_with("END"));
    }

    #[test]
    fn tsql_batches_are_split_on_go_lines_only() {
        let sql = "DECLARE @x INT = 1;\nSELECT @x;\nGO\nSELECT 2\ngo 3\n  -- trailing\nSELECT 3 -- go\nGO -- done\n";
        let t = texts(sql, Some(Dialect::Tsql));
        assert_eq!(
            t,
            [
                "DECLARE @x INT = 1;\nSELECT @x;",
                "SELECT 2",
                "-- trailing\nSELECT 3 -- go"
            ]
        );
    }

    #[test]
    fn go_inside_strings_comments_and_words_is_not_a_separator() {
        let sql = "SELECT 'a\nGO\nb'\n/*\nGO\n*/\nSELECT 1 AS go\nGOTO x\nGO\nSELECT 2";
        let t = texts(sql, Some(Dialect::Tsql));
        assert_eq!(t.len(), 2, "{t:?}");
        assert!(t[0].starts_with("SELECT 'a") && t[0].ends_with("GOTO x"));
        assert_eq!(t[1], "SELECT 2");
    }

    #[test]
    fn tsql_offsets_point_into_the_input() {
        let sql = "SELECT 1\nGO\n  SELECT 2\n";
        let v = split(sql, Some(Dialect::Tsql));
        assert_eq!(v.len(), 2);
        assert_eq!(&sql[v[1].start..v[1].end], "SELECT 2");
    }

    #[test]
    fn oracle_blocks_end_at_a_slash_line_and_other_statements_at_semicolons() {
        let sql = "SELECT 1 FROM dual;\nUPDATE t SET a = 1;\nBEGIN\n  NULL;\n  NULL;\nEND;\n/\nSELECT 2 FROM dual\n/\nSELECT 3 FROM dual;";
        let t = texts(sql, Some(Dialect::Oracle));
        assert_eq!(
            t,
            [
                "SELECT 1 FROM dual",
                "UPDATE t SET a = 1",
                "BEGIN\n  NULL;\n  NULL;\nEND;",
                "SELECT 2 FROM dual",
                "SELECT 3 FROM dual"
            ]
        );
    }

    #[test]
    fn oracle_program_units_keep_their_semicolons() {
        let sql = "CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n  UPDATE t SET a = 1;\n  COMMIT;\nEND;\n/\nDECLARE x NUMBER; BEGIN x := 1; END;\n/";
        let t = texts(sql, Some(Dialect::Oracle));
        assert_eq!(t.len(), 2, "{t:?}");
        assert!(t[0].starts_with("CREATE OR REPLACE PROCEDURE") && t[0].ends_with("END;"));
        assert!(t[1].starts_with("DECLARE"));
    }
}

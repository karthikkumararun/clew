//! Classifying Cypher before it is sent, so the guard that protects SQL sessions (read-only,
//! confirm, typed confirmation on production) protects Neo4j sessions too.
//!
//! There is no Cypher grammar here: a tokenizer that skips strings, comments and `` `quoted` ``
//! names, then keyword rules. When the rules cannot tell, the answer is the cautious one
//! (`Unknown`, which the guard treats as a write), and READ access mode on read-only sessions
//! is the backstop.

use super::classify::{StatementClass, StatementInfo};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    /// An unquoted word, upper-cased (keywords, names, numbers).
    Word(String),
    /// A `` `quoted` `` name, as written.
    Quoted(String),
    /// A string literal; its content is never inspected.
    Str,
    /// `$name`
    Param,
    Punct(char),
}

/// Tokens of one statement, with the byte offsets of each, ignoring strings and comments.
fn tokenize(text: &str) -> Vec<Tok> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            _ if c.is_whitespace() => i += 1,
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i = (i + 2).min(chars.len());
            }
            '\'' | '"' => {
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        i += 2;
                        continue;
                    }
                    if chars[i] == c {
                        // a doubled quote does not end the string
                        if chars.get(i + 1) == Some(&c) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i = (i + 1).min(chars.len());
                out.push(Tok::Str);
            }
            '`' => {
                i += 1;
                let mut name = String::new();
                while i < chars.len() {
                    if chars[i] == '`' {
                        if chars.get(i + 1) == Some(&'`') {
                            name.push('`');
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    name.push(chars[i]);
                    i += 1;
                }
                i = (i + 1).min(chars.len());
                out.push(Tok::Quoted(name));
            }
            '$' => {
                i += 1;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                out.push(Tok::Param);
            }
            _ if c.is_alphanumeric() || c == '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                out.push(Tok::Word(
                    chars[start..i].iter().collect::<String>().to_uppercase(),
                ));
            }
            _ => {
                out.push(Tok::Punct(c));
                i += 1;
            }
        }
    }
    out
}

/// Split at top-level `;` (outside strings, comments and quoted names), keeping each statement's
/// original text. Empty statements are dropped.
pub fn split_statements(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let bytes = text.as_bytes();
    let (mut start, mut i) = (0, 0);
    while i < bytes.len() {
        match bytes[i] {
            b';' => {
                parts.push(&text[start..i]);
                start = i + 1;
                i += 1;
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
            }
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' && q != b'`' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == q {
                        if bytes.get(i + 1) == Some(&q) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    if start <= text.len() {
        parts.push(&text[start.min(text.len())..]);
    }
    parts.retain(|p| !tokenize(p).is_empty());
    parts
}

/// Procedures that only read. `*` at the end matches any suffix.
const READ_PROCEDURES: &[&str] = &[
    "db.labels",
    "db.relationshiptypes",
    "db.propertykeys",
    "db.schema.*",
    "db.indexes",
    "db.constraints",
    "db.info",
    "db.ping",
    "db.index.fulltext.querynodes",
    "db.index.fulltext.queryrelationships",
    "db.index.fulltext.listavailableanalyzers",
    "db.index.vector.querynodes",
    "db.index.vector.queryrelationships",
    "dbms.components",
    "dbms.procedures",
    "dbms.functions",
    "dbms.info",
    "dbms.showcurrentuser",
    "dbms.listconfig",
    "dbms.queryjmx",
];

fn is_read_procedure(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    READ_PROCEDURES.iter().any(|p| match p.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => *p == name,
    })
}

/// Clause keywords that change data.
const WRITE_WORDS: &[&str] = &["CREATE", "MERGE", "SET", "DELETE", "REMOVE", "FOREACH"];

/// Commands that change the schema or the server, by their first word.
const ADMIN_WORDS: &[&str] = &[
    "DROP",
    "ALTER",
    "GRANT",
    "REVOKE",
    "DENY",
    "RENAME",
    "START",
    "STOP",
    "ENABLE",
    "DISABLE",
    "DEALLOCATE",
    "REALLOCATE",
    "TERMINATE",
];

/// Words after which a word is a name, not a clause (`n.set`, `:Set`, `[:A|DELETE]`).
fn is_name_position(toks: &[Tok], i: usize) -> bool {
    let after_name_mark = i > 0 && matches!(toks[i - 1], Tok::Punct('.' | ':' | '|'));
    // `{create: 1}` and `{.set}`
    let map_key = matches!(toks.get(i + 1), Some(Tok::Punct(':')))
        && i > 0
        && matches!(toks[i - 1], Tok::Punct('{' | ','));
    after_name_mark || map_key
}

fn word_at(toks: &[Tok], i: usize) -> Option<&str> {
    match toks.get(i) {
        Some(Tok::Word(w)) if !is_name_position(toks, i) => Some(w.as_str()),
        _ => None,
    }
}

/// Where the statement's real clauses start: after `USE <db>`, `EXPLAIN` and `PROFILE`.
fn body_start(toks: &[Tok]) -> (usize, bool) {
    let mut i = 0;
    let mut explain = false;
    loop {
        match word_at(toks, i) {
            Some("USE") => {
                i += 1;
                // the graph name may be dotted (`composite.graph`)
                while matches!(
                    toks.get(i),
                    Some(Tok::Word(_) | Tok::Quoted(_) | Tok::Punct('.'))
                ) {
                    i += 1;
                }
            }
            Some("EXPLAIN") => {
                explain = true;
                i += 1;
            }
            Some("PROFILE") => i += 1,
            _ => return (i, explain),
        }
    }
}

/// The name in `:use name` (the console's command to switch database).
pub fn use_command(text: &str) -> Option<String> {
    let rest = text.trim().strip_prefix(':')?;
    let (cmd, name) = rest.split_once(char::is_whitespace)?;
    if !cmd.eq_ignore_ascii_case("use") {
        return None;
    }
    let name = name.trim().trim_end_matches(';').trim().trim_matches('`');
    (!name.is_empty() && !name.contains(char::is_whitespace)).then(|| name.to_string())
}

/// The statement's first keyword, upper-case (`MATCH`, `EXPLAIN`, `SHOW`…).
pub fn first_keyword(text: &str) -> Option<String> {
    match tokenize(text).into_iter().next() {
        Some(Tok::Word(w)) => Some(w),
        _ => None,
    }
}

/// Statements Neo4j runs only in an implicit (auto-commit) transaction: `CALL {} IN TRANSACTIONS`
/// and the old `USING PERIODIC COMMIT`; schema and admin commands go there too.
pub fn needs_auto_commit(text: &str) -> bool {
    let toks = tokenize(text);
    for (i, t) in toks.iter().enumerate() {
        if let Tok::Word(w) = t {
            let prev = i.checked_sub(1).and_then(|p| toks.get(p));
            let in_transactions = w == "TRANSACTIONS"
                && matches!(prev, Some(Tok::Word(p)) if p == "IN" || p == "CONCURRENT");
            let numbered = w == "TRANSACTIONS"
                && matches!(prev, Some(Tok::Word(_)))
                && i >= 2
                && matches!(toks.get(i - 2), Some(Tok::Word(x)) if x == "IN");
            let periodic =
                w == "PERIODIC" && matches!(toks.get(i + 1), Some(Tok::Word(c)) if c == "COMMIT");
            if in_transactions || numbered || periodic {
                return true;
            }
        }
    }
    matches!(classify_one(text).class, StatementClass::Ddl)
}

fn info(text: &str, class: StatementClass, danger: Option<String>) -> StatementInfo {
    StatementInfo {
        text: text.trim().to_string(),
        class,
        danger,
    }
}

/// A DELETE whose MATCH has no label, relationship type, property map, WHERE or LIMIT deletes
/// everything it matches.
fn unfiltered_delete(toks: &[Tok], from: usize) -> bool {
    let mut first_match = None;
    let mut first_delete = None;
    for i in from..toks.len() {
        match word_at(toks, i) {
            Some("MATCH") if first_match.is_none() => first_match = Some(i),
            Some("DELETE" | "DETACH") if first_delete.is_none() => first_delete = Some(i),
            _ => {}
        }
    }
    let (Some(m), Some(d)) = (first_match, first_delete) else {
        return false;
    };
    // `MATCH` after the DELETE belongs to a later clause: nothing to judge
    if m > d {
        return false;
    }
    // a label, relationship type or property map in the pattern, or a WHERE / LIMIT, narrows it
    let filtered = (m..toks.len()).any(|i| match &toks[i] {
        Tok::Punct(':' | '{') => i < d,
        _ => matches!(word_at(toks, i), Some("WHERE" | "LIMIT")),
    });
    !filtered
}

fn classify_one(text: &str) -> StatementInfo {
    use StatementClass::*;
    if use_command(text).is_some() {
        return info(text, Control, None);
    }
    let toks = tokenize(text);
    let (start, explain) = body_start(&toks);
    if explain {
        // EXPLAIN plans the query and runs nothing
        return info(text, Read, None);
    }
    let Some(first) = word_at(&toks, start) else {
        return info(text, Read, None);
    };
    if first == "SHOW" {
        return info(text, Read, None);
    }
    if ADMIN_WORDS.contains(&first) {
        return info(text, Ddl, None);
    }
    // `CREATE INDEX`, `CREATE CONSTRAINT`, `CREATE DATABASE`, `CREATE OR REPLACE …`: a CREATE that
    // is not followed by a pattern
    if first == "CREATE" && !matches!(toks.get(start + 1), Some(Tok::Punct('('))) {
        return info(text, Ddl, None);
    }

    let mut writes = false;
    let mut unknown_call = false;
    let mut detach_or_delete = false;
    for i in start..toks.len() {
        let Some(w) = word_at(&toks, i) else { continue };
        match w {
            w if WRITE_WORDS.contains(&w) => {
                // `FOREACH` only appears with updates; `DELETE`/`DETACH` need a target
                writes = true;
                if w == "DELETE" {
                    detach_or_delete = true;
                }
            }
            "DETACH" => detach_or_delete = true,
            "LOAD" if matches!(toks.get(i + 1), Some(Tok::Word(c)) if c == "CSV") => writes = true,
            "CALL" => {
                // `CALL { … }` and `CALL (x) { … }` are subqueries; their clauses are judged above
                let subquery = matches!(toks.get(i + 1), Some(Tok::Punct('{' | '(')));
                if !subquery {
                    let mut name = String::new();
                    let mut j = i + 1;
                    while let Some(t) = toks.get(j) {
                        match t {
                            Tok::Word(w) => name.push_str(w),
                            Tok::Quoted(q) => name.push_str(q),
                            Tok::Punct('.') => name.push('.'),
                            _ => break,
                        }
                        j += 1;
                    }
                    if !is_read_procedure(&name) {
                        unknown_call = true;
                    }
                }
            }
            _ => {}
        }
    }
    if writes {
        let danger = (detach_or_delete && unfiltered_delete(&toks, start)).then(|| {
            "Delete everything this MATCH finds? It has no label, property or WHERE filter."
                .to_string()
        });
        return info(text, Write, danger);
    }
    if unknown_call {
        return info(text, Unknown, None);
    }
    info(text, Read, None)
}

/// Classify Cypher: one entry per `;`-separated statement.
pub fn classify(text: &str) -> Vec<StatementInfo> {
    let statements = split_statements(text);
    if statements.is_empty() {
        return vec![info(text, StatementClass::Read, None)];
    }
    statements.into_iter().map(classify_one).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use StatementClass::*;

    fn class(text: &str) -> StatementClass {
        let all = classify(text);
        // the worst statement decides, like the guard does
        for worst in [Unknown, Ddl, Write, Control, Read] {
            if all.iter().any(|s| s.class == worst) {
                return worst;
            }
        }
        unreachable!()
    }

    fn danger(text: &str) -> bool {
        classify(text).iter().any(|s| s.danger.is_some())
    }

    /// (spec: graph-browser › Cypher safeguards)
    #[test]
    fn reads_are_reads() {
        for q in [
            "MATCH (n:User) RETURN n LIMIT 25",
            "MATCH p=()-[:BOUGHT]->() RETURN p",
            "MATCH (u:User)-[r:BOUGHT]->(p) WHERE p.name = 'Brass Lamp' RETURN u, r, p",
            "WITH 1 AS x UNWIND [1,2] AS y RETURN x + y",
            "RETURN count(*)",
            "MATCH (n) RETURN n.name AS name ORDER BY name SKIP 1",
            "EXPLAIN MATCH (n) RETURN n",
            "SHOW INDEXES",
            "SHOW CONSTRAINTS YIELD name",
            "SHOW DATABASES",
            "USE neo4j MATCH (n) RETURN n",
            "PROFILE MATCH (n:User) RETURN n",
            "MATCH (n) RETURN n // CREATE (x) is only a comment",
            "MATCH (n) /* DELETE n */ RETURN n",
            "",
            "   ",
        ] {
            assert_eq!(class(q), Read, "{q}");
        }
    }

    #[test]
    fn updating_clauses_are_writes() {
        for q in [
            "CREATE (n:Test)",
            "create (n:Test {a: 1}) return n",
            "MERGE (n:User {id: 1})",
            "MATCH (n:User {id: 1}) SET n.plan = 'pro'",
            "MATCH (n:User) SET n += $props",
            "MATCH (n:User {id: 1}) DELETE n",
            "MATCH (n:User {id: 1}) DETACH DELETE n",
            "MATCH (n:User {id: 1}) REMOVE n.plan",
            "MATCH (n:User) REMOVE n:Admin",
            "LOAD CSV FROM 'file:///x.csv' AS row RETURN row",
            "MATCH (n) FOREACH (x IN [1] | SET n.a = x)",
            "MERGE (n:User {id: 1}) ON CREATE SET n.new = true",
            "UNWIND [1] AS x CALL { CREATE (:T) } RETURN x",
            "MATCH (n) WITH n CALL (n) { SET n.a = 1 } RETURN n",
        ] {
            assert_eq!(class(q), Write, "{q}");
        }
    }

    #[test]
    fn schema_and_admin_commands_are_ddl() {
        for q in [
            "CREATE INDEX user_name FOR (u:User) ON (u.name)",
            "CREATE CONSTRAINT FOR (u:User) REQUIRE u.id IS UNIQUE",
            "CREATE RANGE INDEX x FOR (n:A) ON (n.b)",
            "CREATE TEXT INDEX x FOR (n:A) ON (n.b)",
            "CREATE OR REPLACE DATABASE sales",
            "CREATE DATABASE sales",
            "CREATE USER bob SET PASSWORD 'x'",
            "DROP INDEX user_name",
            "DROP CONSTRAINT c IF EXISTS",
            "DROP DATABASE sales",
            "ALTER USER bob SET PASSWORD 'y'",
            "GRANT ROLE admin TO bob",
            "STOP DATABASE sales",
            "TERMINATE TRANSACTIONS 'x'",
        ] {
            assert_eq!(class(q), Ddl, "{q}");
        }
    }

    /// (spec: graph-browser › Cypher safeguards › Read procedure)
    #[test]
    fn calls_of_read_procedures_are_reads_and_others_are_unknown() {
        for q in [
            "CALL db.labels()",
            "CALL db.labels() YIELD label RETURN label",
            "CALL db.relationshipTypes()",
            "CALL db.propertyKeys()",
            "CALL db.schema.visualization()",
            "CALL db.schema.nodeTypeProperties()",
            "CALL dbms.components() YIELD name, versions",
            "call DB.LABELS()",
            "CALL `db`.`labels`()",
            "CALL db.index.fulltext.queryNodes('names', 'ada')",
        ] {
            assert_eq!(class(q), Read, "{q}");
        }
        for q in [
            "CALL apoc.periodic.iterate('a', 'b', {})",
            "CALL db.createLabel('X')",
            "CALL dbms.security.createUser('a', 'b')",
            "CALL apoc.cypher.doIt('x', {})",
            "MATCH (n) CALL custom.thing(n) YIELD x RETURN x",
        ] {
            assert_eq!(class(q), Unknown, "{q}");
        }
        // a subquery is judged by what is inside
        assert_eq!(class("CALL { MATCH (n) RETURN n } RETURN n"), Read);
    }

    /// (spec: graph-browser › Cypher safeguards › Delete everything on production)
    #[test]
    fn deleting_without_a_filter_is_dangerous() {
        for q in [
            "MATCH (n) DETACH DELETE n",
            "match (n) detach delete n",
            "MATCH (n) DELETE n",
            "MATCH (a)-[r]->(b) DELETE r",
            "MATCH (n) WITH n DETACH DELETE n",
            "MATCH p = (a)-[*]->(b) DELETE p",
            "MATCH (n) DETACH DELETE n; RETURN 1",
        ] {
            assert_eq!(class(q), Write, "{q}");
            assert!(danger(q), "{q}");
        }
    }

    #[test]
    fn deleting_with_a_filter_is_a_plain_write() {
        for q in [
            "MATCH (n:Temp) DETACH DELETE n",
            "MATCH (n {id: 7}) DETACH DELETE n",
            "MATCH (n) WHERE n.expired DETACH DELETE n",
            "MATCH (n) WHERE elementId(n) = $id DETACH DELETE n",
            "MATCH (a)-[r:BOUGHT]->(b) DELETE r",
            "MATCH (n) WITH n LIMIT 10 DETACH DELETE n",
            "UNWIND $ids AS id MATCH (n) WHERE id(n) = id DELETE n",
            "CREATE (n:Test)",
            "MATCH (n:User {id: 1}) SET n.a = 1",
        ] {
            assert!(!danger(q), "{q}");
        }
        // a DELETE with no MATCH at all has nothing to be unfiltered
        assert!(!danger("UNWIND $nodes AS n DELETE n"));
    }

    /// Strings, comments and quoted names never count as keywords.
    #[test]
    fn the_tokenizer_ignores_strings_comments_and_names() {
        for q in [
            "MATCH (n) WHERE n.note = 'please CREATE (x) and DELETE it' RETURN n",
            "MATCH (n) WHERE n.note = \"SET n.a = 1\" RETURN n",
            "MATCH (n) WHERE n.note = 'it''s a MERGE' RETURN n",
            "MATCH (n) WHERE n.note = 'back\\'slash DELETE' RETURN n",
            "// DETACH DELETE n\nMATCH (n) RETURN n",
            "MATCH (n:`Delete`) RETURN n",
            "MATCH (n:Set) RETURN n.create, n.delete",
            "MATCH (n)-[r:DELETE|SET]->(m) RETURN r",
            "RETURN {create: 1, remove: 2} AS m",
            "MATCH (n) WHERE n.x = $set AND n.y = $delete RETURN n",
        ] {
            assert_eq!(class(q), Read, "{q}");
        }
        // ...and a real write after them still counts
        assert_eq!(class("MATCH (n) WHERE n.a = 'x;y' DELETE n"), Write);
        assert_eq!(class("/* c */ CREATE (n) // tail"), Write);
    }

    #[test]
    fn statements_are_split_outside_strings_and_the_worst_one_decides() {
        assert_eq!(split_statements("RETURN 1; RETURN 2;").len(), 2);
        assert_eq!(split_statements("RETURN 'a;b'; RETURN `x;y`").len(), 2);
        assert_eq!(split_statements("RETURN 1 // ;\n; RETURN 2").len(), 2);
        assert_eq!(class("MATCH (n) RETURN n; CREATE (x)"), Write);
        assert_eq!(class("RETURN 1; CALL apoc.foo()"), Unknown);
        assert_eq!(classify("RETURN 1; RETURN 2").len(), 2);
    }

    #[test]
    fn the_use_command_is_session_control() {
        assert_eq!(class(":use sales"), Control);
        assert_eq!(use_command(":use sales"), Some("sales".into()));
        assert_eq!(
            use_command(":USE `my db`;"),
            None,
            "names with spaces are refused"
        );
        assert_eq!(use_command(":use `sales`"), Some("sales".into()));
        assert_eq!(use_command("USE sales MATCH (n) RETURN n"), None);
        assert_eq!(use_command(":begin"), None);
    }

    #[test]
    fn implicit_transactions_are_detected() {
        assert!(needs_auto_commit(
            "CALL { MATCH (n) DELETE n } IN TRANSACTIONS OF 100 ROWS"
        ));
        assert!(needs_auto_commit(
            "USING PERIODIC COMMIT LOAD CSV FROM 'x' AS r CREATE (:A)"
        ));
        assert!(needs_auto_commit(
            "CALL { CREATE (:A) } IN 4 CONCURRENT TRANSACTIONS"
        ));
        assert!(needs_auto_commit("CREATE INDEX i FOR (n:A) ON (n.b)"));
        assert!(!needs_auto_commit("MATCH (n) RETURN n"));
        assert!(!needs_auto_commit("SHOW TRANSACTIONS"));
        assert!(!needs_auto_commit("CREATE (n:A)"));
        assert!(!needs_auto_commit("RETURN 'IN TRANSACTIONS'"));
    }

    #[test]
    fn the_first_keyword_skips_comments() {
        assert_eq!(
            first_keyword("  /* x */ explain match (n) return n").as_deref(),
            Some("EXPLAIN")
        );
        assert_eq!(
            first_keyword("// c\nMATCH (n) RETURN n").as_deref(),
            Some("MATCH")
        );
        assert_eq!(first_keyword("`x`"), None);
    }
}

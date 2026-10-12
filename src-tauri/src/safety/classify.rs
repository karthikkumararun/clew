//! What a statement does, decided before it is sent: read, write, DDL, session control or
//! unknown. Parsing uses `sqlparser` with the connection's dialect; anything that fails to parse
//! (or that we don't recognise) is `Unknown`, which the guard treats as a write.

use std::ops::ControlFlow;

use serde::Serialize;
use sqlparser::ast::{
    visit_relations, visit_statements, Delete, FromTable, ObjectType, SetExpr, Statement,
};
use sqlparser::dialect::{
    ClickHouseDialect, Dialect as ParserDialect, DuckDbDialect, GenericDialect, MsSqlDialect,
    MySqlDialect, PostgreSqlDialect, SQLiteDialect,
};
use sqlparser::parser::Parser;

use crate::drivers::split::split;
use crate::drivers::Dialect;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementClass {
    Read,
    Write,
    Ddl,
    /// BEGIN / COMMIT / ROLLBACK / SAVEPOINT / USE / harmless SET: allowed on a read-only session.
    Control,
    Unknown,
}

impl StatementClass {
    /// Changes (or may change) data or schema.
    pub fn mutates(self) -> bool {
        matches!(self, Self::Write | Self::Ddl | Self::Unknown)
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatementInfo {
    pub text: String,
    pub class: StatementClass,
    /// Set for UPDATE / DELETE without WHERE, TRUNCATE and DROP of a table, schema or database:
    /// the question to ask ("Delete every row in orders?").
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub danger: Option<String>,
}

fn parser_dialect(driver: &str) -> Box<dyn ParserDialect> {
    match driver {
        "postgres" | "postgresql" => Box::new(PostgreSqlDialect {}),
        "mysql" | "mariadb" => Box::new(MySqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        "sqlserver" | "mssql" => Box::new(MsSqlDialect {}),
        "clickhouse" => Box::new(ClickHouseDialect {}),
        "duckdb" => Box::new(DuckDbDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

/// The name of the enum variant, e.g. `CreateTable`.
fn variant(stmt: &Statement) -> String {
    format!("{stmt:?}")
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// Whether running the statement can change data: a nested INSERT / UPDATE / DELETE / MERGE (a
/// data-modifying CTE) or `SELECT … INTO`.
fn query_writes(stmt: &Statement) -> bool {
    let mut writes = false;
    let _ = visit_statements(stmt, |s| {
        if matches!(
            s,
            Statement::Insert(_)
                | Statement::Update(_)
                | Statement::Delete(_)
                | Statement::Merge(_)
        ) {
            writes = true;
            return ControlFlow::Break(());
        }
        ControlFlow::<()>::Continue(())
    });
    if writes {
        return true;
    }
    if let Statement::Query(q) = stmt {
        return body_writes(&q.body);
    }
    false
}

fn body_writes(body: &SetExpr) -> bool {
    match body {
        SetExpr::Select(s) => s.into.is_some(),
        SetExpr::Query(q) => body_writes(&q.body),
        SetExpr::SetOperation { left, right, .. } => body_writes(left) || body_writes(right),
        SetExpr::Insert(_) | SetExpr::Update(_) | SetExpr::Delete(_) | SetExpr::Merge(_) => true,
        SetExpr::Values(_) | SetExpr::Table(_) => false,
    }
}

fn first_relation(stmt: &Statement) -> String {
    let mut name = None;
    let _ = visit_relations(stmt, |r| {
        name = Some(r.to_string());
        ControlFlow::<()>::Break(())
    });
    name.unwrap_or_else(|| "the table".to_string())
}

/// Does an `EXPLAIN (…)` option list turn ANALYZE on?
fn explain_analyzes(analyze: bool, options: &Option<Vec<sqlparser::ast::UtilityOption>>) -> bool {
    analyze
        || options.iter().flatten().any(|o| {
            o.name.value.eq_ignore_ascii_case("analyze")
                && o.arg.as_ref().map_or(true, |a| {
                    !matches!(
                        a.to_string().to_ascii_lowercase().as_str(),
                        "false" | "off" | "0"
                    )
                })
        })
}

pub fn classify_statement(stmt: &Statement) -> StatementInfo {
    let text = stmt.to_string();
    let (class, danger) = classify_inner(stmt);
    StatementInfo {
        text,
        class,
        danger,
    }
}

fn classify_inner(stmt: &Statement) -> (StatementClass, Option<String>) {
    use StatementClass::*;
    match stmt {
        Statement::Query(_) => (if query_writes(stmt) { Write } else { Read }, None),
        Statement::Insert(_) | Statement::Merge(_) => (Write, None),
        Statement::Copy { .. } => (Write, None),
        Statement::Update(u) => (
            Write,
            u.selection
                .is_none()
                .then(|| format!("Update every row in {}?", first_relation(stmt))),
        ),
        Statement::Delete(Delete {
            selection, from, ..
        }) => {
            let has_tables = match from {
                FromTable::WithFromKeyword(t) | FromTable::WithoutKeyword(t) => !t.is_empty(),
            };
            (
                Write,
                (selection.is_none() && has_tables)
                    .then(|| format!("Delete every row in {}?", first_relation(stmt))),
            )
        }
        Statement::Truncate(_) => (Ddl, Some(format!("Truncate {}?", first_relation(stmt)))),
        Statement::Drop {
            object_type, names, ..
        } => {
            let kind = match object_type {
                ObjectType::Table => Some("table"),
                ObjectType::Schema => Some("schema"),
                ObjectType::Database => Some("database"),
                _ => None,
            };
            let danger = kind.map(|k| {
                let list = names
                    .iter()
                    .map(|n| n.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("Drop {k} {list}?")
            });
            (Ddl, danger)
        }
        Statement::StartTransaction { .. }
        | Statement::Commit { .. }
        | Statement::Rollback { .. }
        | Statement::Savepoint { .. }
        | Statement::ReleaseSavepoint { .. }
        | Statement::Use(_) => (Control, None),
        Statement::Set(_) => {
            // Session settings are fine, except ones that would lift the read-only protection.
            let text = stmt.to_string().to_ascii_lowercase();
            if text.contains("read") || text.contains("transaction") {
                (Unknown, None)
            } else {
                (Control, None)
            }
        }
        Statement::Explain {
            analyze,
            statement,
            options,
            ..
        } => {
            if explain_analyzes(*analyze, options) {
                let (inner, _) = classify_inner(statement);
                (if inner == Read { Read } else { inner }, None)
            } else {
                (Read, None)
            }
        }
        Statement::ExplainTable { .. } => (Read, None),
        Statement::Pragma { name, value, is_eq } => {
            let reports = READ_PRAGMAS.contains(
                &name
                    .to_string()
                    .rsplit('.')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str(),
            );
            let sets = *is_eq || (value.is_some() && !reports);
            (if sets { Unknown } else { Read }, None)
        }
        _ => {
            let name = variant(stmt);
            if name.starts_with("Show") {
                (Read, None)
            } else if [
                "Create", "Alter", "Drop", "Grant", "Revoke", "Rename", "Comment",
            ]
            .iter()
            .any(|p| name.starts_with(p))
            {
                (Ddl, None)
            } else {
                (Unknown, None)
            }
        }
    }
}

/// A SELECT that touches the same rows as a simple single-table UPDATE or DELETE, to `EXPLAIN` for
/// a row estimate. `None` for anything else (joins, multi-table forms).
pub fn estimate_probe(sql: &str, driver: &str) -> Option<String> {
    let dialect = parser_dialect(driver);
    let stmts = Parser::parse_sql(dialect.as_ref(), sql).ok()?;
    let [stmt] = stmts.as_slice() else {
        return None;
    };
    let (table, selection) = match stmt {
        Statement::Update(u) if u.from.is_none() && u.table.joins.is_empty() => {
            (u.table.to_string(), u.selection.as_ref())
        }
        Statement::Delete(d) if d.using.is_none() && d.tables.is_empty() => {
            let (FromTable::WithFromKeyword(t) | FromTable::WithoutKeyword(t)) = &d.from;
            let [one] = t.as_slice() else { return None };
            if !one.joins.is_empty() {
                return None;
            }
            (one.to_string(), d.selection.as_ref())
        }
        _ => return None,
    };
    Some(match selection {
        Some(w) => format!("SELECT 1 FROM {table} WHERE {w}"),
        None => format!("SELECT 1 FROM {table}"),
    })
}

/// SQLite PRAGMAs that only report. The parser can't read `PRAGMA table_info(users)`, so these
/// are recognised by name; any other PRAGMA with a value or argument may change state.
const READ_PRAGMAS: &[&str] = &[
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "foreign_key_check",
    "database_list",
    "collation_list",
    "function_list",
    "module_list",
    "pragma_list",
    "compile_options",
    "integrity_check",
    "quick_check",
];

fn is_read_pragma(text: &str) -> bool {
    let mut rest = text.trim();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map_or("", |(_, t)| t).trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, t)| t).trim_start();
        } else {
            break;
        }
    }
    let Some(head) = rest.get(..6).filter(|h| h.eq_ignore_ascii_case("pragma")) else {
        return false;
    };
    let body = rest[head.len()..].trim().trim_end_matches(';').trim();
    if body.contains('=') {
        return false;
    }
    let name = body.split('(').next().unwrap_or("").trim();
    let name = name.rsplit('.').next().unwrap_or(name).to_ascii_lowercase();
    READ_PRAGMAS.contains(&name.as_str())
}

/// Classify what `sql` will run. In script mode the text is split the way the driver will split
/// it; otherwise it is parsed as given. Text that doesn't parse is one `Unknown` statement.
pub fn classify(
    sql: &str,
    driver: &str,
    split_as: Option<Dialect>,
    script: bool,
) -> Vec<StatementInfo> {
    if matches!(driver, "mongodb" | "redis") {
        return super::nosql::classify_script(driver, sql, script);
    }
    let dialect = parser_dialect(driver);
    let texts: Vec<String> = if script {
        split(sql, split_as).into_iter().map(|s| s.text).collect()
    } else {
        vec![sql.to_string()]
    };
    let mut out = Vec::new();
    for text in texts {
        if text.trim().is_empty() {
            continue;
        }
        match Parser::parse_sql(dialect.as_ref(), &text) {
            Ok(stmts) if !stmts.is_empty() => out.extend(stmts.iter().map(classify_statement)),
            _ => out.push(StatementInfo {
                text: text.trim().to_string(),
                class: if driver == "sqlite" && is_read_pragma(&text) {
                    StatementClass::Read
                } else {
                    StatementClass::Unknown
                },
                danger: None,
            }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use StatementClass::*;

    fn one(sql: &str, driver: &str) -> StatementInfo {
        let mut v = classify(sql, driver, None, false);
        assert_eq!(v.len(), 1, "{sql}: {v:?}");
        v.remove(0)
    }
    fn class(sql: &str) -> StatementClass {
        one(sql, "postgres").class
    }

    #[test]
    fn reads() {
        for sql in [
            "SELECT 1",
            "select * from t where a = 1",
            "-- note\nSELECT 1",
            "/* hi */ SELECT 1",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "SELECT 1 UNION SELECT 2",
            "VALUES (1), (2)",
            "SHOW search_path",
            "EXPLAIN SELECT 1",
            "EXPLAIN ANALYZE SELECT 1",
            "EXPLAIN (ANALYZE, VERBOSE) SELECT 1",
        ] {
            assert_eq!(class(sql), Read, "{sql}");
        }
    }

    /// (spec: production-safeguards › Data-modifying CTE)
    #[test]
    fn writes() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1 WHERE id = 1",
            "DELETE FROM t WHERE id = 1",
            "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
            "COPY t FROM '/tmp/x.csv'",
            "SELECT * INTO backup FROM t",
            "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
            "WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x",
            "EXPLAIN ANALYZE UPDATE t SET a = 1",
            "EXPLAIN (ANALYZE) DELETE FROM t WHERE id = 1",
        ] {
            assert_eq!(class(sql), Write, "{sql}");
        }
    }

    #[test]
    fn explain_without_analyze_never_executes() {
        assert_eq!(class("EXPLAIN UPDATE t SET a = 1"), Read);
        assert_eq!(class("EXPLAIN (ANALYZE false) DELETE FROM t"), Read);
    }

    #[test]
    fn ddl() {
        for sql in [
            "CREATE TABLE t (id int)",
            "ALTER TABLE t ADD COLUMN b int",
            "DROP TABLE t",
            "DROP INDEX i",
            "TRUNCATE t",
            "GRANT SELECT ON t TO bob",
            "REVOKE SELECT ON t FROM bob",
            "CREATE INDEX i ON t (a)",
            "CREATE VIEW v AS SELECT 1",
        ] {
            assert_eq!(class(sql), Ddl, "{sql}");
        }
    }

    #[test]
    fn control_statements_are_allowed_anywhere() {
        for sql in [
            "BEGIN",
            "START TRANSACTION",
            "COMMIT",
            "ROLLBACK",
            "SAVEPOINT a",
            "SET search_path = public",
        ] {
            assert_eq!(class(sql), Control, "{sql}");
        }
        assert_eq!(one("USE shop", "mysql").class, Control);
    }

    #[test]
    fn settings_that_lift_read_only_are_not_control() {
        for sql in [
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "SET default_transaction_read_only = off",
            "SET TRANSACTION READ WRITE",
        ] {
            assert!(class(sql).mutates(), "{sql}: {:?}", class(sql));
        }
    }

    /// (spec: production-safeguards › Procedure call)
    #[test]
    fn procedure_calls_and_the_unparseable_are_unknown() {
        assert_eq!(class("CALL refresh_stats()"), Unknown);
        assert_eq!(class("SELEC 1"), Unknown);
        assert_eq!(class("VACUUM FULL t"), Unknown);
        assert!(Unknown.mutates());
        assert!(!Read.mutates() && !Control.mutates());
    }

    #[test]
    fn estimates_probe_the_rows_a_simple_update_or_delete_touches() {
        let p = |sql| estimate_probe(sql, "postgres");
        assert_eq!(
            p("UPDATE orders SET status = 'x' WHERE id <= 100").as_deref(),
            Some("SELECT 1 FROM orders WHERE id <= 100")
        );
        assert_eq!(
            p("DELETE FROM public.orders WHERE a = 1 AND b > 2").as_deref(),
            Some("SELECT 1 FROM public.orders WHERE a = 1 AND b > 2")
        );
        assert_eq!(
            p("DELETE FROM orders").as_deref(),
            Some("SELECT 1 FROM orders")
        );
        assert_eq!(p("SELECT 1"), None);
        assert_eq!(p("INSERT INTO t VALUES (1)"), None);
        assert_eq!(p("UPDATE a SET x = b.x FROM b WHERE a.id = b.id"), None);
    }

    #[test]
    fn sqlite_pragmas() {
        assert_eq!(one("PRAGMA table_info(users)", "sqlite").class, Read);
        assert_eq!(one("pragma foreign_key_list('t');", "sqlite").class, Read);
        assert_eq!(one("PRAGMA main.index_list(t)", "sqlite").class, Read);
        assert!(one("PRAGMA foreign_keys = OFF", "sqlite").class.mutates());
        assert!(one("PRAGMA user_version(5)", "sqlite").class.mutates());
        assert!(one("PRAGMA query_only = OFF", "sqlite").class.mutates());
    }

    #[test]
    fn mysql_forms() {
        assert_eq!(one("SHOW TABLES", "mysql").class, Read);
        assert_eq!(one("DESCRIBE users", "mysql").class, Read);
        assert_eq!(
            one("UPDATE `t` SET `a` = 1 WHERE `id` = 2", "mysql").class,
            Write
        );
        assert_eq!(one("INSERT IGNORE INTO t VALUES (1)", "mysql").class, Write);
    }

    #[test]
    fn scripts_are_classified_statement_by_statement() {
        let v = classify(
            "SELECT 1; UPDATE t SET a = 1 WHERE id = 2; -- c\nDELETE FROM t WHERE id = 3;",
            "postgres",
            None,
            true,
        );
        assert_eq!(
            v.iter().map(|s| s.class).collect::<Vec<_>>(),
            [Read, Write, Write]
        );
        let mixed = classify("SELECT 1; SELEC 2", "postgres", None, true);
        assert_eq!(
            mixed.iter().map(|s| s.class).collect::<Vec<_>>(),
            [Read, Unknown]
        );
    }

    #[test]
    fn a_multi_statement_text_in_single_mode_still_sees_every_statement() {
        let v = classify("SELECT 1; DROP TABLE t", "postgres", None, false);
        assert_eq!(v.iter().map(|s| s.class).collect::<Vec<_>>(), [Read, Ddl]);
    }

    #[test]
    fn dangerous_statements() {
        assert_eq!(
            one("DELETE FROM orders", "postgres").danger.as_deref(),
            Some("Delete every row in orders?")
        );
        assert_eq!(
            one("UPDATE orders SET a = 1", "postgres").danger.as_deref(),
            Some("Update every row in orders?")
        );
        assert_eq!(
            one("TRUNCATE orders", "postgres").danger.as_deref(),
            Some("Truncate orders?")
        );
        assert_eq!(
            one("DROP TABLE orders", "postgres").danger.as_deref(),
            Some("Drop table orders?")
        );
        assert_eq!(
            one("DROP SCHEMA app CASCADE", "postgres").danger.as_deref(),
            Some("Drop schema app?")
        );
        assert_eq!(
            one("DROP DATABASE shop", "mysql").danger.as_deref(),
            Some("Drop database shop?")
        );
        for safe in [
            "DELETE FROM orders WHERE id = 1",
            "UPDATE orders SET a = 1 WHERE id = 1",
            "DROP VIEW v",
            "DROP INDEX i",
            "SELECT * FROM orders",
        ] {
            assert_eq!(one(safe, "postgres").danger, None, "{safe}");
        }
    }
}

//! The table editor's staged edits as SQL: UPDATE (guarded by an optimistic check), INSERT and
//! DELETE keyed by the primary or unique key. Values are always bound parameters; the preview
//! shows the same statements with the values written out.

use serde::{Deserialize, Serialize};

use crate::drivers::introspect::NodePath;
use crate::drivers::{DriverResult, Session, Value};
use crate::error::{AppError, AppResult};
use crate::exporter::{sql_literal, SqlFlavor};
use crate::table_query::qualified_name;

/// A value to write: a concrete one, or the column's DEFAULT.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NewValue {
    Value { value: Value },
    Default,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
pub struct CellChange {
    pub column: String,
    /// The value that was loaded; the UPDATE only applies while the row still holds it.
    pub old: Value,
    pub new: NewValue,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
pub struct RowEdit {
    /// Values of the key columns, in `key_columns` order.
    pub key: Vec<Value>,
    pub changes: Vec<CellChange>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
pub struct CellValue {
    pub column: String,
    pub value: NewValue,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
pub struct RowInsert {
    pub values: Vec<CellValue>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
pub struct RowDelete {
    pub key: Vec<Value>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
pub struct ChangeColumn {
    pub name: String,
    /// The database's own type name (used to cast bound text on PostgreSQL).
    pub type_name: String,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequest {
    pub path: NodePath,
    pub columns: Vec<ChangeColumn>,
    pub key_columns: Vec<String>,
    #[serde(default)]
    pub edits: Vec<RowEdit>,
    #[serde(default)]
    pub inserts: Vec<RowInsert>,
    #[serde(default)]
    pub deletes: Vec<RowDelete>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementKind {
    Update,
    Insert,
    Delete,
}

/// Which pending change a statement came from.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ChangeTarget {
    pub kind: StatementKind,
    #[ts(type = "number")]
    pub index: usize,
}

/// A statement ready to run.
#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    pub kind: StatementKind,
    pub sql: String,
    pub params: Vec<Value>,
    pub target: ChangeTarget,
    /// The same statement with the values written out, for the preview and the history.
    pub display: String,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreviewStatement {
    pub kind: StatementKind,
    pub sql: String,
    pub target: ChangeTarget,
}

/// How a value is written into the statement text.
struct Writer<'a> {
    flavor: SqlFlavor,
    /// `Some` renders placeholders and collects parameters; `None` writes literals.
    params: Option<Vec<Value>>,
    types: &'a [(String, String)],
}

impl Writer<'_> {
    fn ty(&self, column: &str) -> Option<&str> {
        self.types
            .iter()
            .find(|(n, _)| n == column)
            .map(|(_, t)| t.as_str())
    }

    /// The expression for `v` as the value of `column`.
    fn value(&mut self, column: &str, v: &Value) -> String {
        match &mut self.params {
            None => sql_literal(self.flavor, v),
            Some(list) => {
                list.push(v.clone());
                let n = list.len();
                match self.flavor {
                    SqlFlavor::Postgres => match self.ty(column) {
                        Some(t) => format!("${n}::{t}"),
                        None => format!("${n}"),
                    },
                    _ => "?".to_string(),
                }
            }
        }
    }
}

fn null_safe_eq(flavor: SqlFlavor, col: &str, rhs: &str, old_is_null: bool) -> String {
    if old_is_null {
        return format!("{col} IS NULL");
    }
    match flavor {
        SqlFlavor::Postgres => format!("{col} IS NOT DISTINCT FROM {rhs}"),
        SqlFlavor::Mysql => format!("{col} <=> {rhs}"),
        SqlFlavor::Sqlite => format!("{col} IS {rhs}"),
        _ => format!("{col} = {rhs}"),
    }
}

fn key_condition(
    w: &mut Writer,
    flavor: SqlFlavor,
    req: &ChangeRequest,
    key: &[Value],
) -> AppResult<String> {
    if req.key_columns.is_empty() || key.len() != req.key_columns.len() {
        return Err(AppError::new(
            "invalid",
            "A row key is needed to change a row",
        ));
    }
    Ok(req
        .key_columns
        .iter()
        .zip(key)
        .map(|(c, v)| {
            let col = flavor.quote_ident(c);
            if v.is_null() {
                format!("{col} IS NULL")
            } else {
                format!("{col} = {}", w.value(c, v))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND "))
}

type Built = (StatementKind, ChangeTarget, String, Vec<Value>);

fn build_one(driver: &str, req: &ChangeRequest, literal: bool) -> AppResult<Vec<Built>> {
    let flavor = SqlFlavor::of_driver(driver);
    let table = qualified_name(driver, &req.path);
    let types: Vec<(String, String)> = req
        .columns
        .iter()
        .map(|c| (c.name.clone(), c.type_name.clone()))
        .collect();
    let mut out = Vec::new();

    for (i, edit) in req.edits.iter().enumerate() {
        if edit.changes.is_empty() {
            continue;
        }
        let mut w = Writer {
            flavor,
            params: (!literal).then(Vec::new),
            types: &types,
        };
        let mut sets = Vec::new();
        for c in &edit.changes {
            let col = flavor.quote_ident(&c.column);
            sets.push(match &c.new {
                NewValue::Default if flavor == SqlFlavor::Sqlite => {
                    return Err(AppError::new(
                        "unsupported",
                        "SQLite can't set a column to DEFAULT",
                    ));
                }
                NewValue::Default => format!("{col} = DEFAULT"),
                NewValue::Value { value } => format!("{col} = {}", w.value(&c.column, value)),
            });
        }
        let mut conds = vec![key_condition(&mut w, flavor, req, &edit.key)?];
        for c in &edit.changes {
            let col = flavor.quote_ident(&c.column);
            let rhs = if c.old.is_null() {
                String::new()
            } else {
                w.value(&c.column, &c.old)
            };
            conds.push(null_safe_eq(flavor, &col, &rhs, c.old.is_null()));
        }
        out.push((
            StatementKind::Update,
            ChangeTarget {
                kind: StatementKind::Update,
                index: i,
            },
            format!(
                "UPDATE {table} SET {} WHERE {}",
                sets.join(", "),
                conds.join(" AND ")
            ),
            w.params.unwrap_or_default(),
        ));
    }

    for (i, ins) in req.inserts.iter().enumerate() {
        let mut w = Writer {
            flavor,
            params: (!literal).then(Vec::new),
            types: &types,
        };
        let set: Vec<(&str, &Value)> = ins
            .values
            .iter()
            .filter_map(|v| match &v.value {
                NewValue::Value { value } => Some((v.column.as_str(), value)),
                NewValue::Default => None,
            })
            .collect();
        let sql = if set.is_empty() {
            match flavor {
                SqlFlavor::Mysql => format!("INSERT INTO {table} () VALUES ()"),
                _ => format!("INSERT INTO {table} DEFAULT VALUES"),
            }
        } else {
            let cols = set
                .iter()
                .map(|(c, _)| flavor.quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            let vals = set
                .iter()
                .map(|(c, v)| w.value(c, v))
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {table} ({cols}) VALUES ({vals})")
        };
        out.push((
            StatementKind::Insert,
            ChangeTarget {
                kind: StatementKind::Insert,
                index: i,
            },
            sql,
            w.params.unwrap_or_default(),
        ));
    }

    for (i, del) in req.deletes.iter().enumerate() {
        let mut w = Writer {
            flavor,
            params: (!literal).then(Vec::new),
            types: &types,
        };
        let cond = key_condition(&mut w, flavor, req, &del.key)?;
        out.push((
            StatementKind::Delete,
            ChangeTarget {
                kind: StatementKind::Delete,
                index: i,
            },
            format!("DELETE FROM {table} WHERE {cond}"),
            w.params.unwrap_or_default(),
        ));
    }
    Ok(out)
}

/// Statements in the order they run: updates, inserts, deletes.
pub fn build(driver: &str, req: &ChangeRequest) -> AppResult<Vec<Statement>> {
    let bound = build_one(driver, req, false)?;
    let shown = build_one(driver, req, true)?;
    Ok(bound
        .into_iter()
        .zip(shown)
        .map(
            |((kind, target, sql, params), (_, _, display, _))| Statement {
                kind,
                sql,
                params,
                target,
                display,
            },
        )
        .collect())
}

pub fn preview(statements: &[Statement]) -> Vec<PreviewStatement> {
    statements
        .iter()
        .map(|s| PreviewStatement {
            kind: s.kind,
            sql: format!("{};", s.display),
            target: s.target,
        })
        .collect()
}

/// Why a statement stopped the batch.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangeFailure {
    pub target: ChangeTarget,
    pub message: String,
    /// The row changed or vanished since it was loaded (the optimistic check matched nothing).
    pub conflict: bool,
}

/// Everything ran and was committed, or nothing changed and `failure` says why.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApplyOutcome {
    #[ts(type = "number")]
    pub applied: usize,
    pub failure: Option<ChangeFailure>,
}

/// Run `statements` as one unit. Outside a user transaction that is BEGIN … COMMIT; inside one it
/// is a savepoint, so the user's own transaction survives a failed batch. An UPDATE or DELETE that
/// matches no row means the optimistic check failed: the whole batch is rolled back.
pub async fn apply(
    session: &mut dyn Session,
    driver: &str,
    in_transaction: bool,
    statements: &[Statement],
) -> DriverResult<ApplyOutcome> {
    let (begin, commit, rollback) = if in_transaction {
        (
            "SAVEPOINT clew_changes",
            "RELEASE SAVEPOINT clew_changes",
            "ROLLBACK TO SAVEPOINT clew_changes",
        )
    } else if driver == "mysql" || driver == "mariadb" {
        ("START TRANSACTION", "COMMIT", "ROLLBACK")
    } else {
        ("BEGIN", "COMMIT", "ROLLBACK")
    };
    session.execute_params(begin, &[]).await?;
    for st in statements {
        let result = session.execute_params(&st.sql, &st.params).await;
        let failure = match result {
            Ok(0) if st.kind != StatementKind::Insert => Some(ChangeFailure {
                target: st.target,
                message: "The row was changed or deleted by someone else since it was loaded."
                    .to_string(),
                conflict: true,
            }),
            Ok(_) => None,
            Err(e) => Some(ChangeFailure {
                target: st.target,
                message: e.message.clone(),
                conflict: false,
            }),
        };
        if let Some(failure) = failure {
            // A failed statement aborts a PostgreSQL transaction; rolling back is the only way on.
            let _ = session.execute_params(rollback, &[]).await;
            if in_transaction {
                let _ = session
                    .execute_params("RELEASE SAVEPOINT clew_changes", &[])
                    .await;
            }
            return Ok(ApplyOutcome {
                applied: 0,
                failure: Some(failure),
            });
        }
    }
    session.execute_params(commit, &[]).await?;
    Ok(ApplyOutcome {
        applied: statements.len(),
        failure: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::introspect::NodeKind;

    fn int(n: i64) -> Value {
        Value::Int { value: n }
    }
    fn text(s: &str) -> Value {
        Value::Text {
            value: s.into(),
            truncated: false,
        }
    }
    fn set(v: Value) -> NewValue {
        NewValue::Value { value: v }
    }
    fn col(name: &str, ty: &str) -> ChangeColumn {
        ChangeColumn {
            name: name.into(),
            type_name: ty.into(),
        }
    }

    fn pg_request() -> ChangeRequest {
        ChangeRequest {
            path: NodePath::root()
                .child(NodeKind::Database, "analytics")
                .child(NodeKind::Schema, "public")
                .child(NodeKind::Group, "tables")
                .child(NodeKind::Table, "orders"),
            columns: vec![
                col("id", "bigint"),
                col("status", "order_status"),
                col("total", "numeric(12,2)"),
                col("notes", "text"),
                col("shipped_at", "timestamp with time zone"),
            ],
            key_columns: vec!["id".into()],
            edits: vec![RowEdit {
                key: vec![int(88213)],
                changes: vec![
                    CellChange {
                        column: "status".into(),
                        old: text("pending"),
                        new: set(text("shipped")),
                    },
                    CellChange {
                        column: "notes".into(),
                        old: Value::Null,
                        new: set(text("it's fine")),
                    },
                ],
            }],
            inserts: vec![RowInsert {
                values: vec![
                    CellValue {
                        column: "status".into(),
                        value: set(text("pending")),
                    },
                    CellValue {
                        column: "total".into(),
                        value: set(Value::Decimal {
                            value: "12.50".into(),
                        }),
                    },
                    CellValue {
                        column: "notes".into(),
                        value: NewValue::Default,
                    },
                ],
            }],
            deletes: vec![RowDelete {
                key: vec![int(88001)],
            }],
        }
    }

    #[test]
    fn postgres_matches_the_golden_statements() {
        let statements = build("postgres", &pg_request()).unwrap();
        let sqls: Vec<_> = statements.iter().map(|s| s.sql.as_str()).collect();
        assert_eq!(
            sqls,
            [
                r#"UPDATE "public"."orders" SET "status" = $1::order_status, "notes" = $2::text WHERE "id" = $3::bigint AND "status" IS NOT DISTINCT FROM $4::order_status AND "notes" IS NULL"#,
                r#"INSERT INTO "public"."orders" ("status", "total") VALUES ($1::order_status, $2::numeric(12,2))"#,
                r#"DELETE FROM "public"."orders" WHERE "id" = $1::bigint"#,
            ]
        );
        assert_eq!(
            statements[0].params,
            vec![
                text("shipped"),
                text("it's fine"),
                int(88213),
                text("pending")
            ]
        );
        assert_eq!(
            statements[1].params,
            vec![
                text("pending"),
                Value::Decimal {
                    value: "12.50".into()
                }
            ]
        );
        assert_eq!(statements[2].params, vec![int(88001)]);
    }

    #[test]
    fn the_preview_writes_the_values_out_and_keys_each_row() {
        let shown: Vec<_> = preview(&build("postgres", &pg_request()).unwrap())
            .into_iter()
            .map(|p| p.sql)
            .collect();
        assert_eq!(
            shown,
            [
                r#"UPDATE "public"."orders" SET "status" = 'shipped', "notes" = 'it''s fine' WHERE "id" = 88213 AND "status" IS NOT DISTINCT FROM 'pending' AND "notes" IS NULL;"#,
                r#"INSERT INTO "public"."orders" ("status", "total") VALUES ('pending', 12.50);"#,
                r#"DELETE FROM "public"."orders" WHERE "id" = 88001;"#,
            ]
        );
    }

    #[test]
    fn sqlite_uses_question_marks_and_is() {
        let mut req = pg_request();
        req.path = NodePath::root()
            .child(NodeKind::Database, "main")
            .child(NodeKind::Table, "orders");
        let statements = build("sqlite", &req).unwrap();
        assert_eq!(
            statements[0].sql,
            r#"UPDATE "main"."orders" SET "status" = ?, "notes" = ? WHERE "id" = ? AND "status" IS ? AND "notes" IS NULL"#
        );
        assert_eq!(
            statements[1].sql,
            r#"INSERT INTO "main"."orders" ("status", "total") VALUES (?, ?)"#
        );
        assert_eq!(
            statements[2].sql,
            r#"DELETE FROM "main"."orders" WHERE "id" = ?"#
        );
        assert_eq!(statements[0].params.len(), 4);
    }

    #[test]
    fn mysql_uses_the_null_safe_operator_and_backticks() {
        let mut req = pg_request();
        req.path = NodePath::root()
            .child(NodeKind::Database, "shop")
            .child(NodeKind::Group, "tables")
            .child(NodeKind::Table, "orders");
        let statements = build("mysql", &req).unwrap();
        assert_eq!(
            statements[0].sql,
            "UPDATE `shop`.`orders` SET `status` = ?, `notes` = ? WHERE `id` = ? AND `status` <=> ? AND `notes` IS NULL"
        );
        assert_eq!(statements[0].display, "UPDATE `shop`.`orders` SET `status` = 'shipped', `notes` = 'it''s fine' WHERE `id` = 88213 AND `status` <=> 'pending' AND `notes` IS NULL");
    }

    #[test]
    fn composite_keys_and_defaults() {
        let mut req = pg_request();
        req.key_columns = vec!["id".into(), "status".into()];
        req.deletes.clear();
        req.inserts.clear();
        req.edits = vec![RowEdit {
            key: vec![int(1), text("pending")],
            changes: vec![CellChange {
                column: "notes".into(),
                old: text("x"),
                new: NewValue::Default,
            }],
        }];
        let s = &build("postgres", &req).unwrap()[0];
        assert_eq!(
            s.sql,
            r#"UPDATE "public"."orders" SET "notes" = DEFAULT WHERE "id" = $1::bigint AND "status" = $2::order_status AND "notes" IS NOT DISTINCT FROM $3::text"#
        );
        // SQLite has no DEFAULT keyword in UPDATE.
        let mut lite = req.clone();
        lite.path = NodePath::root()
            .child(NodeKind::Database, "main")
            .child(NodeKind::Table, "t");
        assert_eq!(build("sqlite", &lite).unwrap_err().code, "unsupported");
    }

    #[test]
    fn an_insert_of_only_defaults_uses_the_dialects_form() {
        let mut req = pg_request();
        req.edits.clear();
        req.deletes.clear();
        req.inserts = vec![RowInsert {
            values: vec![CellValue {
                column: "notes".into(),
                value: NewValue::Default,
            }],
        }];
        assert_eq!(
            build("postgres", &req).unwrap()[0].sql,
            r#"INSERT INTO "public"."orders" DEFAULT VALUES"#
        );
        req.path = NodePath::root()
            .child(NodeKind::Database, "shop")
            .child(NodeKind::Group, "tables")
            .child(NodeKind::Table, "orders");
        assert_eq!(
            build("mysql", &req).unwrap()[0].sql,
            "INSERT INTO `shop`.`orders` () VALUES ()"
        );
    }

    #[test]
    fn a_missing_key_is_refused_and_empty_edits_are_skipped() {
        let mut req = pg_request();
        req.key_columns.clear();
        assert_eq!(build("postgres", &req).unwrap_err().code, "invalid");
        let mut req = pg_request();
        req.edits[0].changes.clear();
        req.inserts.clear();
        req.deletes.clear();
        assert!(build("postgres", &req).unwrap().is_empty());
    }

    #[test]
    fn values_are_never_spliced_into_the_bound_sql() {
        let mut req = pg_request();
        req.edits[0].changes[0].new = set(text("x'; DROP TABLE orders; --"));
        let s = &build("postgres", &req).unwrap()[0];
        assert!(!s.sql.contains("DROP"), "{}", s.sql);
        assert!(s.params.contains(&text("x'; DROP TABLE orders; --")));
    }
}

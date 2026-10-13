//! The table editor's staged edits as SQL: UPDATE (guarded by an optimistic check), INSERT and
//! DELETE keyed by the primary or unique key. Values are always bound parameters; the preview
//! shows the same statements with the values written out.

use serde::{Deserialize, Serialize};

use crate::drivers::introspect::NodePath;
use crate::drivers::{DriverResult, ExecRequest, ResultEvent, Session, Value};
use crate::editability::TableRef;
use crate::error::{AppError, AppResult};
use crate::exporter::{sql_literal, SqlFlavor};
use crate::sessions::SessionManager;
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
    /// Submitting from a console in Manual transaction mode (see [`ApplyOptions::manual`]). The
    /// table editor leaves this off.
    #[serde(default)]
    #[ts(optional)]
    pub manual: Option<bool>,
    /// Commit the open transaction after a successful submit ("Submit and commit").
    #[serde(default)]
    #[ts(optional)]
    pub commit_after: Option<bool>,
}

impl ChangeRequest {
    pub fn options(&self) -> ApplyOptions {
        ApplyOptions {
            manual: self.manual.unwrap_or(false),
            commit_after: self.commit_after.unwrap_or(false),
        }
    }
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
                    SqlFlavor::Sqlserver => format!("@P{n}"),
                    SqlFlavor::Oracle => format!(":{n}"),
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

/// Everything ran, or nothing changed and `failure` says why.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApplyOutcome {
    /// Statements applied: the amount to add to the console's transaction statement counter.
    #[ts(type = "number")]
    pub applied: usize,
    pub failure: Option<ChangeFailure>,
    /// The session is inside a transaction after the call (a manual-mode submit leaves it open).
    #[serde(rename = "transactionOpen")]
    #[ts(rename = "transactionOpen")]
    pub transaction_open: bool,
}

/// How a submit relates to the console's transaction.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ApplyOptions {
    /// The console is in Manual transaction mode: run inside its transaction, beginning one when
    /// none is open, and leave the transaction open afterwards.
    pub manual: bool,
    /// "Submit and commit": after a successful submit, commit the whole open transaction.
    pub commit_after: bool,
}

struct Plan {
    begin: Option<&'static str>,
    savepoint: Option<&'static str>,
    release: Option<&'static str>,
    rollback_to: Option<&'static str>,
    commit: &'static str,
    rollback: &'static str,
}

/// The statements that bracket a submit, per dialect. `open_first` is a transaction this submit
/// has to begin itself; `inside` is a transaction that is already open (or just begun).
fn plan(driver: &str, inside: bool, open_first: bool) -> Plan {
    let tsql = driver == "sqlserver";
    let oracle = driver == "oracle";
    let mysql = driver == "mysql" || driver == "mariadb";
    let begin_text = if mysql {
        "START TRANSACTION"
    } else if tsql || oracle {
        "BEGIN TRANSACTION"
    } else {
        "BEGIN"
    };
    // Oracle begins transactions implicitly with the first statement.
    let begin = (!inside || (open_first && !oracle)).then_some(begin_text);
    // T-SQL and Oracle have no RELEASE SAVEPOINT (a savepoint just stays).
    let (savepoint, release, rollback_to) = match (inside, tsql, oracle) {
        (false, _, _) => (None, None, None),
        (true, true, _) => (
            Some("SAVE TRANSACTION clew_changes"),
            None,
            Some("ROLLBACK TRANSACTION clew_changes"),
        ),
        (true, _, true) => (
            Some("SAVEPOINT clew_changes"),
            None,
            Some("ROLLBACK TO SAVEPOINT clew_changes"),
        ),
        (true, false, false) => (
            Some("SAVEPOINT clew_changes"),
            Some("RELEASE SAVEPOINT clew_changes"),
            Some("ROLLBACK TO SAVEPOINT clew_changes"),
        ),
    };
    Plan {
        begin,
        savepoint,
        release,
        rollback_to,
        commit: "COMMIT",
        rollback: "ROLLBACK",
    }
}

/// Run `statements` as one unit.
///
/// - Outside a transaction in auto-commit mode: BEGIN, the statements, COMMIT.
/// - Inside the console's transaction: a savepoint, so the transaction survives a failed batch
///   exactly as it was. In Manual mode with no transaction open yet, one is begun first (and
///   rolled back again if the batch fails, so the session is as it was); on success the
///   statements stay in the transaction unless `commit_after` commits it.
///
/// An UPDATE or DELETE that matches no row means the optimistic check failed: the whole batch is
/// rolled back.
pub async fn apply(
    session: &mut dyn Session,
    driver: &str,
    in_transaction: bool,
    options: ApplyOptions,
    statements: &[Statement],
) -> DriverResult<ApplyOutcome> {
    let open_first = options.manual && !in_transaction;
    let inside = in_transaction || options.manual;
    let plan = plan(driver, inside, open_first);

    if let Some(begin) = plan.begin {
        session.execute_params(begin, &[]).await?;
    }
    if let Some(savepoint) = plan.savepoint {
        if let Err(e) = session.execute_params(savepoint, &[]).await {
            if open_first {
                let _ = session.execute_params(plan.rollback, &[]).await;
            }
            return Err(e);
        }
    }
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
            let transaction_open = if inside {
                if let Some(rollback_to) = plan.rollback_to {
                    let _ = session.execute_params(rollback_to, &[]).await;
                }
                if let Some(release) = plan.release {
                    let _ = session.execute_params(release, &[]).await;
                }
                if open_first {
                    // The transaction was this submit's: leave the session as it was found.
                    let _ = session.execute_params(plan.rollback, &[]).await;
                }
                !open_first
            } else {
                let _ = session.execute_params(plan.rollback, &[]).await;
                false
            };
            return Ok(ApplyOutcome {
                applied: 0,
                failure: Some(failure),
                transaction_open,
            });
        }
    }
    let mut transaction_open = inside;
    if inside {
        if let Some(release) = plan.release {
            session.execute_params(release, &[]).await?;
        }
        if options.commit_after {
            session.execute_params(plan.commit, &[]).await?;
            transaction_open = false;
        }
    } else {
        session.execute_params(plan.commit, &[]).await?;
    }
    Ok(ApplyOutcome {
        applied: statements.len(),
        failure: None,
        transaction_open,
    })
}

// ---------------------------------------------------------------------------------------------
// Read-back after a submit
// ---------------------------------------------------------------------------------------------

/// Keys read back per statement.
pub const REFETCH_BATCH: usize = 200;

fn qualified_table(flavor: SqlFlavor, target: &TableRef) -> String {
    match &target.schema {
        Some(s) => format!(
            "{}.{}",
            flavor.quote_ident(s),
            flavor.quote_ident(&target.table)
        ),
        None => flavor.quote_ident(&target.table),
    }
}

/// How a key is compared across the wire: the literal it would be written as.
fn key_text(flavor: SqlFlavor, key: &[Value]) -> String {
    key.iter()
        .map(|v| sql_literal(flavor, v))
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

/// `SELECT <keys>, <columns> FROM target WHERE <keys match>` for one batch. The key columns come
/// first so the rows can be matched back to their keys. A key with a NULL in it matches nothing
/// and is left out; `None` when no key is left. Values are written as literals (the session API
/// has no parameterised read), escaped for the dialect like the preview does.
pub fn refetch_sql(
    driver: &str,
    target: &TableRef,
    columns: &[String],
    key_columns: &[String],
    keys: &[Vec<Value>],
) -> AppResult<Option<String>> {
    if key_columns.is_empty() {
        return Err(AppError::new(
            "invalid",
            "A row key is needed to read rows back",
        ));
    }
    if keys.iter().any(|k| k.len() != key_columns.len()) {
        return Err(AppError::new(
            "invalid",
            "A key does not match the key columns",
        ));
    }
    let flavor = SqlFlavor::of_driver(driver);
    let usable: Vec<&Vec<Value>> = keys
        .iter()
        .filter(|k| k.iter().all(|v| !v.is_null()))
        .collect();
    if usable.is_empty() {
        return Ok(None);
    }
    let quoted = |c: &String| flavor.quote_ident(c);
    let select = key_columns
        .iter()
        .chain(columns)
        .map(quoted)
        .collect::<Vec<_>>()
        .join(", ");
    let condition = if key_columns.len() == 1 {
        let list = usable
            .iter()
            .map(|k| sql_literal(flavor, &k[0]))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{} IN ({list})", quoted(&key_columns[0]))
    } else {
        usable
            .iter()
            .map(|k| {
                let parts = key_columns
                    .iter()
                    .zip(k.iter())
                    .map(|(c, v)| format!("{} = {}", quoted(c), sql_literal(flavor, v)))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                format!("({parts})")
            })
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    Ok(Some(format!(
        "SELECT {select} FROM {} WHERE {condition}",
        qualified_table(flavor, target)
    )))
}

/// Line the fetched rows (key columns first) up with the requested keys: one entry per key, in
/// order, holding the row without its key columns, or empty when the row is gone.
pub fn match_rows(
    driver: &str,
    key_len: usize,
    keys: &[Vec<Value>],
    fetched: Vec<Vec<Value>>,
) -> Vec<Vec<Value>> {
    let flavor = SqlFlavor::of_driver(driver);
    let mut by_key: std::collections::HashMap<String, Vec<Value>> = fetched
        .into_iter()
        .filter(|r| r.len() >= key_len)
        .map(|mut r| {
            let rest = r.split_off(key_len);
            (key_text(flavor, &r), rest)
        })
        .collect();
    keys.iter()
        .map(|k| by_key.remove(&key_text(flavor, k)).unwrap_or_default())
        .collect()
}

/// Read rows back by key on the console's own session (so uncommitted changes show): the values
/// of `columns` for each key, in the order of `keys`, an empty row where the row no longer exists.
pub async fn refetch(
    sessions: &SessionManager,
    driver: &str,
    session_id: &str,
    target: &TableRef,
    columns: &[String],
    key_columns: &[String],
    keys: &[Vec<Value>],
) -> AppResult<Vec<Vec<Value>>> {
    let mut out = Vec::with_capacity(keys.len());
    for batch in keys.chunks(REFETCH_BATCH) {
        let Some(sql) = refetch_sql(driver, target, columns, key_columns, batch)? else {
            out.extend(batch.iter().map(|_| Vec::new()));
            continue;
        };
        let rows: std::sync::Arc<std::sync::Mutex<Vec<Vec<Value>>>> = Default::default();
        let sink = rows.clone();
        let emit: crate::sessions::Emit = std::sync::Arc::new(move |event| {
            if let ResultEvent::Rows { rows: chunk, .. } = event {
                sink.lock().unwrap().extend(chunk);
            }
            true
        });
        let request = ExecRequest {
            sql,
            page_size: REFETCH_BATCH * 4,
            script: false,
            continue_on_error: false,
        };
        sessions
            .execute_unrecorded(session_id, request, emit)
            .await?;
        let fetched = std::mem::take(&mut *rows.lock().unwrap());
        out.extend(match_rows(driver, key_columns.len(), batch, fetched));
    }
    Ok(out)
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
            manual: None,
            commit_after: None,
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

    // ---- submit and transactions ------------------------------------------------------------

    use crate::drivers::{
        CancelHandle, DriverError, ErrorCode, ExecSummary, ResultId, ResultSink, ServerInfo,
    };
    use async_trait::async_trait;

    /// A session that records what it is asked to run. A statement containing `fail_on` fails;
    /// one containing `no_rows` changes no row.
    struct Recorder {
        ran: Vec<String>,
        fail_on: Option<&'static str>,
        no_rows: Option<&'static str>,
    }

    impl Recorder {
        fn new() -> Self {
            Self {
                ran: Vec::new(),
                fail_on: None,
                no_rows: None,
            }
        }
    }

    #[async_trait]
    impl Session for Recorder {
        async fn execute(&mut self, _: ExecRequest, _: ResultSink) -> DriverResult<ExecSummary> {
            unreachable!("apply only runs bound statements")
        }
        async fn execute_params(&mut self, sql: &str, _: &[Value]) -> DriverResult<u64> {
            self.ran.push(sql.to_string());
            if self.fail_on.is_some_and(|f| sql.contains(f)) {
                return Err(DriverError::new(
                    ErrorCode::QueryFailed,
                    "null value in column \"status\" violates not-null constraint",
                ));
            }
            Ok(if self.no_rows.is_some_and(|f| sql.contains(f)) {
                0
            } else {
                1
            })
        }
        async fn fetch_more(&mut self, _: ResultId, _: usize, _: ResultSink) -> DriverResult<bool> {
            Ok(false)
        }
        fn cancel_handle(&self) -> CancelHandle {
            unreachable!()
        }
        fn server_info(&self) -> ServerInfo {
            unreachable!()
        }
        async fn close(self: Box<Self>) -> DriverResult<()> {
            Ok(())
        }
    }

    fn submit() -> Vec<Statement> {
        build("postgres", &pg_request()).unwrap()
    }

    fn manual() -> ApplyOptions {
        ApplyOptions {
            manual: true,
            commit_after: false,
        }
    }

    fn without_dml(ran: &[String]) -> Vec<&str> {
        ran.iter()
            .map(String::as_str)
            .filter(|s| {
                !(s.starts_with("UPDATE") || s.starts_with("INSERT") || s.starts_with("DELETE"))
            })
            .collect()
    }

    /// (spec: result-editing › Auto-commit submit)
    #[tokio::test]
    async fn auto_commit_submit_runs_in_its_own_transaction_and_commits() {
        let mut s = Recorder::new();
        let out = apply(
            &mut s,
            "postgres",
            false,
            ApplyOptions::default(),
            &submit(),
        )
        .await
        .unwrap();
        assert_eq!(out.applied, 3);
        assert!(out.failure.is_none());
        assert!(!out.transaction_open);
        assert_eq!(without_dml(&s.ran), ["BEGIN", "COMMIT"]);
    }

    /// (spec: result-editing › Manual mode submit)
    #[tokio::test]
    async fn manual_submit_begins_a_transaction_and_leaves_it_open() {
        for (driver, begin) in [
            ("postgres", "BEGIN"),
            ("sqlite", "BEGIN"),
            ("mysql", "START TRANSACTION"),
            ("mariadb", "START TRANSACTION"),
        ] {
            let mut s = Recorder::new();
            let out = apply(&mut s, driver, false, manual(), &submit())
                .await
                .unwrap();
            assert_eq!(
                out.applied, 3,
                "{driver}: the counter grows by the statements submitted"
            );
            assert!(out.transaction_open, "{driver}");
            assert_eq!(
                without_dml(&s.ran),
                [
                    begin,
                    "SAVEPOINT clew_changes",
                    "RELEASE SAVEPOINT clew_changes"
                ],
                "{driver}"
            );
        }
    }

    /// (spec: result-editing › Manual mode submit)
    #[tokio::test]
    async fn manual_submit_in_an_open_transaction_only_adds_a_savepoint() {
        let mut s = Recorder::new();
        let out = apply(&mut s, "postgres", true, manual(), &submit())
            .await
            .unwrap();
        assert!(out.transaction_open);
        assert_eq!(
            without_dml(&s.ran),
            ["SAVEPOINT clew_changes", "RELEASE SAVEPOINT clew_changes"]
        );
    }

    /// (spec: result-editing › Failure keeps the transaction)
    #[tokio::test]
    async fn a_failed_manual_submit_rolls_back_to_the_savepoint_and_keeps_the_transaction() {
        let mut s = Recorder::new();
        s.fail_on = Some("INSERT");
        let out = apply(&mut s, "postgres", true, manual(), &submit())
            .await
            .unwrap();
        assert_eq!(out.applied, 0);
        let failure = out.failure.expect("the failure is reported");
        assert!(failure.message.contains("not-null"));
        assert_eq!(failure.target.kind, StatementKind::Insert);
        assert!(out.transaction_open, "the user's transaction is as it was");
        let ran = without_dml(&s.ran);
        assert_eq!(
            ran,
            [
                "SAVEPOINT clew_changes",
                "ROLLBACK TO SAVEPOINT clew_changes",
                "RELEASE SAVEPOINT clew_changes"
            ]
        );
        assert!(!s.ran.iter().any(|r| r == "ROLLBACK" || r == "COMMIT"));
    }

    /// (spec: result-editing › Failure keeps the transaction)
    #[tokio::test]
    async fn a_failed_manual_submit_that_began_the_transaction_leaves_none_behind() {
        let mut s = Recorder::new();
        s.fail_on = Some("INSERT");
        let out = apply(&mut s, "postgres", false, manual(), &submit())
            .await
            .unwrap();
        assert!(out.failure.is_some());
        assert!(!out.transaction_open);
        assert_eq!(s.ran.first().map(String::as_str), Some("BEGIN"));
        assert_eq!(s.ran.last().map(String::as_str), Some("ROLLBACK"));
    }

    /// (spec: result-editing › Row changed by someone else)
    #[tokio::test]
    async fn a_row_that_matched_nothing_fails_the_batch_as_a_conflict() {
        let mut s = Recorder::new();
        s.no_rows = Some("UPDATE");
        let out = apply(&mut s, "postgres", true, manual(), &submit())
            .await
            .unwrap();
        let failure = out.failure.expect("conflict");
        assert!(failure.conflict);
        assert_eq!(failure.target.kind, StatementKind::Update);
        assert!(out.transaction_open);
        assert!(s
            .ran
            .iter()
            .any(|r| r == "ROLLBACK TO SAVEPOINT clew_changes"));
    }

    /// (spec: result-editing › Submit and commit)
    #[tokio::test]
    async fn submit_and_commit_commits_the_whole_open_transaction() {
        let mut s = Recorder::new();
        let options = ApplyOptions {
            manual: true,
            commit_after: true,
        };
        let out = apply(&mut s, "postgres", true, options, &submit())
            .await
            .unwrap();
        assert_eq!(out.applied, 3);
        assert!(!out.transaction_open);
        assert_eq!(s.ran.last().map(String::as_str), Some("COMMIT"));
        // A failed submit-and-commit commits nothing.
        let mut s = Recorder::new();
        s.fail_on = Some("DELETE");
        let out = apply(&mut s, "postgres", true, options, &submit())
            .await
            .unwrap();
        assert!(out.failure.is_some());
        assert!(out.transaction_open);
        assert!(!s.ran.iter().any(|r| r == "COMMIT"));
    }

    /// (spec: result-editing › Manual mode submit)
    #[tokio::test]
    async fn sql_server_and_oracle_use_their_own_savepoint_syntax() {
        let mut s = Recorder::new();
        apply(&mut s, "sqlserver", false, manual(), &submit())
            .await
            .unwrap();
        assert_eq!(
            without_dml(&s.ran),
            ["BEGIN TRANSACTION", "SAVE TRANSACTION clew_changes"]
        );
        let mut s = Recorder::new();
        s.fail_on = Some("INSERT");
        apply(&mut s, "sqlserver", true, manual(), &submit())
            .await
            .unwrap();
        assert!(s
            .ran
            .iter()
            .any(|r| r == "ROLLBACK TRANSACTION clew_changes"));

        let mut s = Recorder::new();
        apply(&mut s, "oracle", false, manual(), &submit())
            .await
            .unwrap();
        assert_eq!(
            without_dml(&s.ran),
            ["SAVEPOINT clew_changes"],
            "Oracle starts its transaction by itself"
        );
    }

    // ---- read-back --------------------------------------------------------------------------

    fn orders_ref() -> TableRef {
        TableRef {
            schema: Some("public".into()),
            table: "orders".into(),
        }
    }

    /// (spec: result-editing › Generated key appears)
    #[test]
    fn read_back_selects_the_key_and_the_columns_for_a_batch_of_keys() {
        let sql = refetch_sql(
            "postgres",
            &orders_ref(),
            &["status".into(), "total".into()],
            &["id".into()],
            &[vec![int(1)], vec![int(2)], vec![Value::Null]],
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            sql,
            r#"SELECT "id", "status", "total" FROM "public"."orders" WHERE "id" IN (1, 2)"#
        );
    }

    /// (spec: result-editing › Generated key appears)
    #[test]
    fn read_back_of_a_composite_key_ors_the_ands_and_escapes_text() {
        let sql = refetch_sql(
            "mysql",
            &TableRef {
                schema: Some("shop".into()),
                table: "items".into(),
            },
            &["v".into()],
            &["tenant".into(), "code".into()],
            &[vec![int(1), text("a'b\\c")], vec![int(2), text("x")]],
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            sql,
            "SELECT `tenant`, `code`, `v` FROM `shop`.`items` WHERE (`tenant` = 1 AND `code` = 'a''b\\\\c') OR (`tenant` = 2 AND `code` = 'x')"
        );
        assert!(refetch_sql("postgres", &orders_ref(), &[], &[], &[]).is_err());
        assert_eq!(
            refetch_sql(
                "postgres",
                &orders_ref(),
                &["a".into()],
                &["id".into()],
                &[vec![Value::Null]]
            )
            .unwrap(),
            None,
            "a NULL key matches nothing"
        );
    }

    /// (spec: result-editing › Generated key appears)
    #[test]
    fn fetched_rows_line_up_with_the_keys_and_missing_rows_are_empty() {
        let keys = vec![vec![int(3)], vec![int(1)], vec![int(2)]];
        let fetched = vec![
            vec![int(1), text("shipped")],
            vec![Value::Bigint { value: "3".into() }, text("pending")],
        ];
        let rows = match_rows("postgres", 1, &keys, fetched);
        assert_eq!(rows[0], vec![text("pending")]);
        assert_eq!(rows[1], vec![text("shipped")]);
        assert!(rows[2].is_empty(), "key 2 no longer exists");
    }
}

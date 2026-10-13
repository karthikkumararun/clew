//! Putting it together: provenance (or statement analysis) says which table each result column
//! comes from; the introspection cache says what that table's key and generated columns are.
//!
//! Three steps, the middle one the only one that talks to a database:
//! 1. [`plan`] groups the result's columns by table (pure);
//! 2. [`resolve_edit`] loads each table's structure (cached);
//! 3. [`finish`] picks the edit target and says what is editable (pure).

use super::analyze::{analyze, Analysis, Item, Unsupported};
use super::{Cache, Candidate, ColumnEdit, EditResolution, ReadOnlyCode, ReadOnlyReason, TableRef};
use crate::drivers::introspect::{NodeKind, NodePath};
use crate::drivers::table_meta::{Generation, TableMeta};
use crate::drivers::{split_source, ColumnMeta, DriverResult};
use crate::sessions::SessionManager;

// ---------------------------------------------------------------------------------------------
// Table structure
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnInfo {
    pub name: String,
    pub nullable: bool,
    pub has_default: bool,
    pub generated: Option<Generation>,
}

/// A way to identify one row of a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInfo {
    pub columns: Vec<String>,
    pub primary: bool,
}

/// What resolution needs to know about one table.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TableInfo {
    pub columns: Vec<ColumnInfo>,
    /// The primary key first, then every unique index whose columns are all non-null.
    pub keys: Vec<KeyInfo>,
    pub is_view: bool,
}

impl TableInfo {
    pub fn from_meta(meta: &TableMeta) -> Self {
        let columns: Vec<ColumnInfo> = meta
            .columns
            .iter()
            .map(|c| ColumnInfo {
                name: c.name.clone(),
                nullable: c.nullable,
                has_default: c.default.is_some() || c.generated.is_some(),
                generated: c.generated,
            })
            .collect();
        let known = |name: &str| meta.columns.iter().find(|c| c.name == name);

        let mut keys = Vec::new();
        let primary = meta
            .indexes
            .iter()
            .find(|i| i.primary)
            .map(|i| i.columns.clone())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| {
                meta.columns
                    .iter()
                    .filter(|c| c.primary_key)
                    .map(|c| c.name.clone())
                    .collect()
            });
        if !primary.is_empty() {
            keys.push(KeyInfo {
                columns: primary,
                primary: true,
            });
        }
        for index in meta.indexes.iter().filter(|i| i.unique && !i.primary) {
            let usable = !index.columns.is_empty()
                && index
                    .columns
                    .iter()
                    .all(|c| known(c).is_some_and(|d| !d.nullable));
            if usable {
                keys.push(KeyInfo {
                    columns: index.columns.clone(),
                    primary: false,
                });
            }
        }
        Self {
            columns,
            keys,
            is_view: meta.is_view.unwrap_or(false),
        }
    }

    fn column(&self, name: &str) -> Option<&ColumnInfo> {
        self.columns.iter().find(|c| c.name == name).or_else(|| {
            self.columns
                .iter()
                .find(|c| c.name.eq_ignore_ascii_case(name))
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Step 1: group the result's columns by table
// ---------------------------------------------------------------------------------------------

/// A result column read from a table column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// Index in the result.
    pub index: usize,
    /// The table column, as the driver or the statement names it.
    pub column: String,
    /// The driver says the column can't be written (computed or generated always).
    pub driver_read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub table: TableRef,
    pub members: Vec<Member>,
}

/// Why nothing in the result can be traced to an editable table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blocked {
    /// DISTINCT, GROUP BY, aggregates, window functions, set operations.
    Aggregate,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// The groups came from parsing the statement rather than the driver.
    pub inferred: bool,
    /// Tables in `FROM` order.
    pub groups: Vec<Group>,
    pub blocked: Option<Blocked>,
}

fn blocked(b: Blocked) -> Plan {
    Plan {
        inferred: false,
        groups: Vec::new(),
        blocked: Some(b),
    }
}

/// The table column names a driver gives as `source_table` (`schema.table` for PostgreSQL and
/// MySQL) split into schema and table.
fn provenance_table(c: &ColumnMeta) -> Option<TableRef> {
    let qualified = c.source_table.as_deref()?;
    let (schema, table) = match &c.source_schema {
        Some(s) => (
            Some(s.clone()),
            qualified
                .strip_prefix(&format!("{s}."))
                .unwrap_or(qualified)
                .to_string(),
        ),
        None => {
            let (s, t) = split_source(qualified);
            (s.map(str::to_string), t.to_string())
        }
    };
    Some(TableRef { schema, table })
}

/// `default_schema` is where an unqualified table name in the statement lives.
pub fn plan(
    driver: &str,
    default_schema: Option<&str>,
    statement: &str,
    columns: &[ColumnMeta],
) -> Plan {
    let analysis = analyze(driver, statement);
    if columns.iter().any(|c| c.source_table.is_some()) {
        plan_from_provenance(&analysis, columns)
    } else {
        plan_from_analysis(&analysis, default_schema, columns)
    }
}

fn plan_from_provenance(analysis: &Analysis, columns: &[ColumnMeta]) -> Plan {
    // The rows of DISTINCT / GROUP BY / UNION results are not table rows, whatever the columns say.
    if analysis.unsupported().is_some_and(Unsupported::is_computed) {
        return blocked(Blocked::Aggregate);
    }
    let mut groups: Vec<Group> = Vec::new();
    for (index, c) in columns.iter().enumerate() {
        let (Some(table), Some(column)) = (provenance_table(c), c.source_column.clone()) else {
            continue;
        };
        let member = Member {
            index,
            column,
            driver_read_only: c.source_updatable == Some(false),
        };
        match groups.iter_mut().find(|g| g.table.same_as(&table)) {
            Some(g) => g.members.push(member),
            None => groups.push(Group {
                table,
                members: vec![member],
            }),
        }
    }
    // `FROM` order, where the statement shows it; columns' order otherwise.
    let from: Vec<TableRef> = analysis
        .tables()
        .iter()
        .map(|t| TableRef {
            schema: t.schema.clone(),
            table: t.name.clone(),
        })
        .collect();
    groups.sort_by_key(|g| {
        from.iter()
            .position(|t| t.same_as(&g.table))
            .unwrap_or(usize::MAX)
    });
    Plan {
        inferred: false,
        groups,
        blocked: None,
    }
}

fn plan_from_analysis(
    analysis: &Analysis,
    default_schema: Option<&str>,
    columns: &[ColumnMeta],
) -> Plan {
    let (table, items) = match analysis {
        Analysis::Single { table, items } => (table, items),
        Analysis::Unsupported { reason, .. } => {
            return blocked(if reason.is_computed() {
                Blocked::Aggregate
            } else {
                Blocked::Unknown
            })
        }
    };
    let n = columns.len();
    let wildcards = items.iter().filter(|i| **i == Item::Wildcard).count();
    // Which table column each result column reads (None: an expression).
    let mut mapped: Vec<Option<String>> = vec![None; n];
    if wildcards == 0 {
        if items.len() != n {
            return blocked(Blocked::Unknown);
        }
        for (i, item) in items.iter().enumerate() {
            if let Item::Column { column, .. } = item {
                mapped[i] = Some(column.clone());
            }
        }
    } else if wildcards == 1 && items.len() - 1 <= n {
        let at = items
            .iter()
            .position(|i| *i == Item::Wildcard)
            .expect("one");
        let after = items.len() - at - 1;
        for (i, item) in items[..at].iter().enumerate() {
            if let Item::Column { column, .. } = item {
                mapped[i] = Some(column.clone());
            }
        }
        for i in at..n - after {
            mapped[i] = Some(columns[i].name.clone());
        }
        for (k, item) in items[at + 1..].iter().enumerate() {
            if let Item::Column { column, .. } = item {
                mapped[n - after + k] = Some(column.clone());
            }
        }
    } else {
        return blocked(Blocked::Unknown);
    }
    let members: Vec<Member> = mapped
        .into_iter()
        .enumerate()
        .filter_map(|(index, column)| {
            Some(Member {
                index,
                column: column?,
                driver_read_only: false,
            })
        })
        .collect();
    if members.is_empty() {
        return blocked(Blocked::Unknown);
    }
    Plan {
        inferred: true,
        groups: vec![Group {
            table: TableRef {
                schema: table
                    .schema
                    .clone()
                    .or_else(|| default_schema.map(str::to_string)),
                table: table.name.clone(),
            },
            members,
        }],
        blocked: None,
    }
}

// ---------------------------------------------------------------------------------------------
// Step 3: choose the target and describe the columns
// ---------------------------------------------------------------------------------------------

/// What step 2 found for each table, by position in `Plan::groups`.
pub type Loaded = Vec<Result<TableInfo, String>>;

struct Evaluated {
    table: TableRef,
    candidate: Candidate,
    /// The key to use: the first one fully present in the result, else the first one.
    key: Option<KeyInfo>,
    /// The key's column names are those of the table, so they are canonical.
    mapped: Vec<(usize, String)>,
}

fn evaluate(group: &Group, info: &Result<TableInfo, String>) -> Evaluated {
    let mut candidate = Candidate {
        schema: group.table.schema.clone(),
        table: group.table.table.clone(),
        available: false,
        missing_keys: Vec::new(),
        no_key: false,
        is_view: false,
    };
    let Ok(info) = info else {
        return Evaluated {
            table: group.table.clone(),
            candidate,
            key: None,
            mapped: Vec::new(),
        };
    };
    // The table's own spelling of each mapped column.
    let mapped: Vec<(usize, String)> = group
        .members
        .iter()
        .map(|m| {
            (
                m.index,
                info.column(&m.column)
                    .map_or_else(|| m.column.clone(), |c| c.name.clone()),
            )
        })
        .collect();
    let has = |name: &str| mapped.iter().any(|(_, c)| c == name);
    candidate.is_view = info.is_view;
    let key = info
        .keys
        .iter()
        .find(|k| k.columns.iter().all(|c| has(c)))
        .or_else(|| info.keys.first())
        .cloned();
    match &key {
        None => candidate.no_key = true,
        Some(k) => {
            candidate.missing_keys = k.columns.iter().filter(|c| !has(c)).cloned().collect();
        }
    }
    candidate.available = !info.is_view && key.is_some() && candidate.missing_keys.is_empty();
    Evaluated {
        table: group.table.clone(),
        candidate,
        key,
        mapped,
    }
}

fn read_only(code: ReadOnlyCode, message: String, fix: Option<String>) -> ReadOnlyReason {
    ReadOnlyReason { code, message, fix }
}

/// The reason shown when no table of the result can be the target.
fn none_available(groups: &[Group], loaded: &Loaded, evaluated: &[Evaluated]) -> ReadOnlyReason {
    if let ([group], [info], [e]) = (groups, loaded.as_slice(), evaluated) {
        let t = &group.table;
        if let Err(why) = info {
            return read_only(
                ReadOnlyCode::Unknown,
                format!("Can't read the structure of {}: {why}", t.display()),
                None,
            );
        }
        if e.candidate.is_view {
            return read_only(
                ReadOnlyCode::View,
                format!("{} is a view", t.display()),
                None,
            );
        }
        if e.candidate.no_key {
            return read_only(
                ReadOnlyCode::NoKeyOnTable,
                format!(
                    "{} has no primary or unique key, so its rows can't be identified.",
                    t.table
                ),
                None,
            );
        }
        let missing = e.candidate.missing_keys.join(", ");
        let kind = if e.key.as_ref().is_some_and(|k| k.primary) {
            "primary"
        } else {
            "unique"
        };
        return read_only(
            ReadOnlyCode::NoKeyInResult,
            format!(
                "No {kind} key in the result for {}. Add {missing} to the SELECT.",
                t.table
            ),
            Some(format!("Add {missing} to the SELECT")),
        );
    }
    let detail: Vec<String> = groups
        .iter()
        .zip(evaluated)
        .map(|(g, e)| {
            if e.candidate.is_view {
                format!("{} is a view", g.table.table)
            } else if e.candidate.no_key {
                format!("{} has no key", g.table.table)
            } else {
                format!(
                    "{}: add {}",
                    g.table.table,
                    e.candidate.missing_keys.join(", ")
                )
            }
        })
        .collect();
    read_only(
        ReadOnlyCode::MultipleTables,
        format!(
            "None of the tables in this result has its whole key. {}.",
            detail.join("; ")
        ),
        None,
    )
}

/// Pick the edit target (`chosen` if it is available, else the first available table) and say
/// what can be edited. `result_len` is the number of result columns.
pub fn finish(
    plan: &Plan,
    loaded: &Loaded,
    result_len: usize,
    chosen: Option<&TableRef>,
) -> EditResolution {
    let unknown = || EditResolution::ReadOnly {
        reason: read_only(
            ReadOnlyCode::Unknown,
            "Can't tell which table these columns come from".to_string(),
            None,
        ),
        candidates: Vec::new(),
    };
    match plan.blocked {
        Some(Blocked::Aggregate) => {
            return EditResolution::ReadOnly {
                reason: read_only(
                    ReadOnlyCode::Aggregate,
                    "Aggregate or computed result".to_string(),
                    None,
                ),
                candidates: Vec::new(),
            }
        }
        Some(Blocked::Unknown) => return unknown(),
        None => {}
    }
    if plan.groups.is_empty() || loaded.len() != plan.groups.len() {
        return unknown();
    }
    let evaluated: Vec<Evaluated> = plan
        .groups
        .iter()
        .zip(loaded)
        .map(|(g, info)| evaluate(g, info))
        .collect();
    let candidates: Vec<Candidate> = evaluated.iter().map(|e| e.candidate.clone()).collect();

    let pick = chosen
        .and_then(|c| {
            evaluated
                .iter()
                .position(|e| e.candidate.available && e.table.same_as(c))
        })
        .or_else(|| evaluated.iter().position(|e| e.candidate.available));
    let Some(pick) = pick else {
        return EditResolution::ReadOnly {
            reason: none_available(&plan.groups, loaded, &evaluated),
            candidates,
        };
    };

    let group = &plan.groups[pick];
    let e = &evaluated[pick];
    let info = loaded[pick].as_ref().expect("available implies loaded");
    let key = e.key.as_ref().expect("available implies a key");

    let mut column_map: Vec<Option<String>> = vec![None; result_len];
    for (i, name) in &e.mapped {
        if *i < result_len {
            column_map[*i] = Some(name.clone());
        }
    }
    let key_indexes: Vec<usize> = key
        .columns
        .iter()
        .filter_map(|k| {
            column_map
                .iter()
                .position(|m| m.as_deref() == Some(k.as_str()))
        })
        .collect();

    let columns: Vec<ColumnEdit> = (0..result_len)
        .map(|i| {
            if let Some(name) = &column_map[i] {
                let member = group.members.iter().find(|m| m.index == i);
                let col = info.column(name);
                let (editable, reason) = match (col, member) {
                    (None, _) => (
                        false,
                        Some(format!("{name} is not a column of {}", group.table.table)),
                    ),
                    (Some(c), _) if c.generated == Some(Generation::Always) => (
                        false,
                        Some(format!("{name} is always generated by the database")),
                    ),
                    (_, Some(m)) if m.driver_read_only => (
                        false,
                        Some(format!("{name} is computed or generated by the database")),
                    ),
                    _ => (true, None),
                };
                return ColumnEdit {
                    editable,
                    reason,
                    nullable: col.map_or(true, |c| c.nullable),
                    has_default: col.is_some_and(|c| c.has_default),
                };
            }
            let other = plan
                .groups
                .iter()
                .enumerate()
                .find(|(g, grp)| *g != pick && grp.members.iter().any(|m| m.index == i));
            let reason = match other {
                Some((_, grp)) => format!(
                    "Belongs to {}, not to {}, the table being edited",
                    grp.table.display(),
                    group.table.display()
                ),
                None => "Computed by the query, not a column of a table".to_string(),
            };
            ColumnEdit {
                editable: false,
                reason: Some(reason),
                nullable: true,
                has_default: false,
            }
        })
        .collect();

    EditResolution::Editable {
        target: group.table.clone(),
        inferred: plan.inferred,
        column_map,
        key_columns: key.columns.clone(),
        key_indexes,
        columns,
        candidates,
    }
}

// ---------------------------------------------------------------------------------------------
// Step 2 and the entry point
// ---------------------------------------------------------------------------------------------

/// Where an unqualified table of a statement lives, per driver.
fn default_schema(driver: &str, database: Option<&str>, user: Option<&str>) -> Option<String> {
    match driver {
        "postgres" => Some("public".into()),
        "sqlserver" => Some("dbo".into()),
        "duckdb" | "sqlite" => Some("main".into()),
        "oracle" => user.map(str::to_uppercase),
        _ => database.map(str::to_string),
    }
}

/// The introspection path of a table, as each driver's `table_meta` wants it.
fn table_path(driver: &str, database: Option<&str>, t: &TableRef) -> NodePath {
    let root = NodePath::root();
    let schema = t.schema.as_deref();
    match driver {
        "postgres" => {
            let p = root.child(NodeKind::Schema, schema.unwrap_or("public"));
            p.child(NodeKind::Group, "tables")
                .child(NodeKind::Table, &t.table)
        }
        "oracle" => root
            .child(NodeKind::Schema, schema.unwrap_or_default())
            .child(NodeKind::Table, &t.table),
        "sqlserver" | "duckdb" => {
            let mut p = root;
            if let Some(db) = database {
                p = p.child(NodeKind::Database, db);
            }
            p.child(NodeKind::Schema, schema.unwrap_or("main"))
                .child(NodeKind::Table, &t.table)
        }
        // MySQL, MariaDB, ClickHouse: the schema is the database. SQLite: the attached database.
        _ => root
            .child(NodeKind::Database, schema.or(database).unwrap_or("main"))
            .child(NodeKind::Table, &t.table),
    }
}

async fn load(
    sessions: &SessionManager,
    cache: &Cache,
    connection_id: &str,
    driver: &str,
    database: Option<&str>,
    table: &TableRef,
) -> Result<TableInfo, String> {
    if let Some(info) = cache.get(connection_id, table) {
        return Ok(info);
    }
    let path = table_path(driver, database, table);
    let meta = sessions
        .table_meta(connection_id, &path)
        .await
        .map_err(|e| e.message)?;
    if meta.columns.is_empty() {
        return Err("the table was not found".to_string());
    }
    let info = TableInfo::from_meta(&meta);
    cache.put(connection_id, table, info.clone());
    Ok(info)
}

/// Resolve a result for editing: see the module comment. Infrastructure failures are errors; a
/// result that can't be edited is `EditResolution::ReadOnly`.
pub async fn resolve_edit(
    sessions: &SessionManager,
    cache: &Cache,
    connection_id: &str,
    session_id: &str,
    statement: &str,
    columns: &[ColumnMeta],
    chosen: Option<&TableRef>,
) -> DriverResult<EditResolution> {
    let ctx = sessions.resolve_context(connection_id, session_id).await?;
    if ctx.read_only {
        let message = if ctx.production {
            "This session is read-only (PRODUCTION)"
        } else {
            "This session is read-only"
        };
        return Ok(EditResolution::ReadOnly {
            reason: read_only(
                ReadOnlyCode::SessionReadOnly,
                message.to_string(),
                Some("Switch to read-write".to_string()),
            ),
            candidates: Vec::new(),
        });
    }
    let schema = default_schema(&ctx.driver, ctx.database.as_deref(), ctx.user.as_deref());
    let plan = plan(&ctx.driver, schema.as_deref(), statement, columns);
    let mut loaded: Loaded = Vec::new();
    for g in &plan.groups {
        loaded.push(
            load(
                sessions,
                cache,
                connection_id,
                &ctx.driver,
                ctx.database.as_deref(),
                &g.table,
            )
            .await,
        );
    }
    Ok(finish(&plan, &loaded, columns.len(), chosen))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::table_meta::{ColumnDetail, IndexDetail};
    use crate::drivers::ValueKind;

    /// A result column with provenance (`orders.status AS state` is `prov("state", "public.orders", "status")`).
    fn prov(name: &str, table: &str, column: &str) -> ColumnMeta {
        let schema = table.split_once('.').map(|(s, _)| s.to_string());
        ColumnMeta {
            name: name.into(),
            type_name: "text".into(),
            kind: ValueKind::Text,
            nullable: None,
            source_table: Some(table.into()),
            source_column: Some(column.into()),
            source_schema: schema,
            source_updatable: Some(true),
        }
    }

    /// A result column the driver could not trace (an expression, or any column on Oracle).
    fn bare(name: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            type_name: "text".into(),
            kind: ValueKind::Text,
            nullable: None,
            source_table: None,
            source_column: None,
            source_schema: None,
            source_updatable: None,
        }
    }

    fn expr(name: &str) -> ColumnMeta {
        ColumnMeta {
            source_updatable: Some(false),
            ..bare(name)
        }
    }

    fn detail(name: &str, nullable: bool, pk: bool) -> ColumnDetail {
        ColumnDetail {
            name: name.into(),
            type_name: "text".into(),
            nullable,
            default: None,
            primary_key: pk,
            comment: None,
            generated: None,
        }
    }

    fn unique(name: &str, columns: &[&str]) -> IndexDetail {
        IndexDetail {
            name: name.into(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            unique: true,
            primary: false,
            method: None,
            size_bytes: None,
        }
    }

    fn pk(columns: &[&str]) -> IndexDetail {
        IndexDetail {
            primary: true,
            ..unique("pk", columns)
        }
    }

    fn orders() -> TableInfo {
        TableInfo::from_meta(&TableMeta {
            columns: vec![
                detail("id", false, true),
                detail("status", true, false),
                detail("total", true, false),
                ColumnDetail {
                    generated: Some(Generation::Always),
                    ..detail("fingerprint", true, false)
                },
                ColumnDetail {
                    generated: Some(Generation::ByDefault),
                    ..detail("seq", false, false)
                },
            ],
            indexes: vec![pk(&["id"])],
            ..Default::default()
        })
    }

    fn users() -> TableInfo {
        TableInfo::from_meta(&TableMeta {
            columns: vec![detail("id", false, true), detail("name", true, false)],
            indexes: vec![pk(&["id"])],
            ..Default::default()
        })
    }

    fn keyless() -> TableInfo {
        TableInfo::from_meta(&TableMeta {
            columns: vec![detail("a", true, false), detail("b", true, false)],
            ..Default::default()
        })
    }

    /// Run the pure part of resolution: `tables` is what the introspection cache would return.
    fn run(
        driver: &str,
        sql: &str,
        columns: Vec<ColumnMeta>,
        tables: Vec<(&str, TableInfo)>,
        chosen: Option<TableRef>,
    ) -> EditResolution {
        let plan = plan(driver, Some("public"), sql, &columns);
        let loaded: Loaded = plan
            .groups
            .iter()
            .map(|g| {
                tables
                    .iter()
                    .find(|(n, _)| n.eq_ignore_ascii_case(&g.table.table))
                    .map(|(_, i)| Ok(i.clone()))
                    .unwrap_or_else(|| Err("missing in test".into()))
            })
            .collect();
        finish(&plan, &loaded, columns.len(), chosen.as_ref())
    }

    fn editable(r: &EditResolution) -> (&TableRef, &[Option<String>], &[String], &[usize]) {
        match r {
            EditResolution::Editable {
                target,
                column_map,
                key_columns,
                key_indexes,
                ..
            } => (target, column_map, key_columns, key_indexes),
            other => panic!("expected editable, got {other:?}"),
        }
    }

    fn reason(r: &EditResolution) -> &ReadOnlyReason {
        match r {
            EditResolution::ReadOnly { reason, .. } => reason,
            other => panic!("expected read-only, got {other:?}"),
        }
    }

    fn candidates(r: &EditResolution) -> &[Candidate] {
        match r {
            EditResolution::Editable { candidates, .. }
            | EditResolution::ReadOnly { candidates, .. } => candidates,
        }
    }

    fn t(schema: &str, table: &str) -> TableRef {
        TableRef {
            schema: Some(schema.into()),
            table: table.into(),
        }
    }

    /// (spec: result-editing › Single table with its key)
    #[test]
    fn single_table_with_its_key_is_editable() {
        let r = run(
            "postgres",
            "SELECT id, status, total FROM orders WHERE status = 'pending'",
            vec![
                prov("id", "public.orders", "id"),
                prov("status", "public.orders", "status"),
                prov("total", "public.orders", "total"),
            ],
            vec![("orders", orders())],
            None,
        );
        let (target, map, key, key_idx) = editable(&r);
        assert_eq!(target, &t("public", "orders"));
        assert_eq!(
            map,
            [
                Some("id".into()),
                Some("status".into()),
                Some("total".into())
            ]
        );
        assert_eq!(key, ["id"]);
        assert_eq!(key_idx, [0]);
        let EditResolution::Editable {
            columns, inferred, ..
        } = &r
        else {
            unreachable!()
        };
        assert!(!inferred);
        assert!(columns.iter().all(|c| c.editable));
    }

    /// (spec: result-editing › Aliased and reordered columns)
    #[test]
    fn aliased_and_reordered_columns_map_to_table_columns() {
        let r = run(
            "postgres",
            "SELECT total AS amount, id AS order_id FROM orders",
            vec![
                prov("amount", "public.orders", "total"),
                prov("order_id", "public.orders", "id"),
            ],
            vec![("orders", orders())],
            None,
        );
        let (_, map, key, key_idx) = editable(&r);
        assert_eq!(map, [Some("total".into()), Some("id".into())]);
        assert_eq!(key, ["id"]);
        assert_eq!(key_idx, [1], "the key is the second result column");
    }

    /// (spec: result-editing › Expression columns stay read-only)
    #[test]
    fn expression_columns_stay_read_only() {
        let r = run(
            "postgres",
            "SELECT id, status, total * 1.2 AS with_tax FROM orders",
            vec![
                prov("id", "public.orders", "id"),
                prov("status", "public.orders", "status"),
                expr("with_tax"),
            ],
            vec![("orders", orders())],
            None,
        );
        let EditResolution::Editable {
            columns,
            column_map,
            ..
        } = &r
        else {
            panic!("editable expected")
        };
        assert!(columns[0].editable && columns[1].editable);
        assert!(!columns[2].editable);
        assert!(columns[2]
            .reason
            .as_deref()
            .unwrap()
            .contains("Computed by the query"));
        assert_eq!(column_map[2], None);
    }

    /// (spec: result-editing › Generated and identity columns)
    #[test]
    fn generated_always_is_locked_and_generated_by_default_is_not() {
        let r = run(
            "postgres",
            "SELECT id, fingerprint, seq FROM orders",
            vec![
                prov("id", "public.orders", "id"),
                prov("fingerprint", "public.orders", "fingerprint"),
                prov("seq", "public.orders", "seq"),
            ],
            vec![("orders", orders())],
            None,
        );
        let EditResolution::Editable { columns, .. } = &r else {
            panic!("editable expected")
        };
        assert!(!columns[1].editable);
        assert!(columns[1]
            .reason
            .as_deref()
            .unwrap()
            .contains("always generated"));
        assert!(columns[2].editable, "GENERATED BY DEFAULT can be edited");
        assert!(columns[2].has_default);
    }

    /// (spec: result-editing › Generated and identity columns)
    #[test]
    fn a_driver_that_flags_a_column_not_updatable_locks_it() {
        let mut computed = prov("status", "public.orders", "status");
        computed.source_updatable = Some(false);
        let r = run(
            "postgres",
            "SELECT id, status FROM orders",
            vec![prov("id", "public.orders", "id"), computed],
            vec![("orders", orders())],
            None,
        );
        let EditResolution::Editable { columns, .. } = &r else {
            panic!("editable expected")
        };
        assert!(!columns[1].editable);
    }

    /// (spec: result-editing › Key missing)
    #[test]
    fn missing_key_names_the_column_to_add() {
        let r = run(
            "postgres",
            "SELECT status, total FROM orders",
            vec![
                prov("status", "public.orders", "status"),
                prov("total", "public.orders", "total"),
            ],
            vec![("orders", orders())],
            None,
        );
        let why = reason(&r);
        assert_eq!(why.code, ReadOnlyCode::NoKeyInResult);
        assert_eq!(
            why.message,
            "No primary key in the result for orders. Add id to the SELECT."
        );
        assert_eq!(why.fix.as_deref(), Some("Add id to the SELECT"));
        assert_eq!(candidates(&r)[0].missing_keys, ["id"]);
    }

    /// (spec: result-editing › Key missing)
    #[test]
    fn a_composite_key_must_be_complete() {
        let two = TableInfo::from_meta(&TableMeta {
            columns: vec![
                detail("tenant", false, true),
                detail("id", false, true),
                detail("v", true, false),
            ],
            indexes: vec![pk(&["tenant", "id"])],
            ..Default::default()
        });
        let r = run(
            "postgres",
            "SELECT id, v FROM items",
            vec![
                prov("id", "public.items", "id"),
                prov("v", "public.items", "v"),
            ],
            vec![("items", two)],
            None,
        );
        assert_eq!(
            reason(&r).message,
            "No primary key in the result for items. Add tenant to the SELECT."
        );
    }

    /// (spec: result-editing › No key anywhere)
    #[test]
    fn a_table_without_a_key_says_rows_cannot_be_identified() {
        let r = run(
            "postgres",
            "SELECT a, b FROM log",
            vec![prov("a", "public.log", "a"), prov("b", "public.log", "b")],
            vec![("log", keyless())],
            None,
        );
        let why = reason(&r);
        assert_eq!(why.code, ReadOnlyCode::NoKeyOnTable);
        assert!(
            why.message.contains("no primary or unique key"),
            "{}",
            why.message
        );
        assert!(
            why.message.contains("can't be identified"),
            "{}",
            why.message
        );
        assert!(candidates(&r)[0].no_key);
    }

    /// (spec: result-editing › No key anywhere)
    #[test]
    fn a_unique_index_of_non_null_columns_is_a_key() {
        let by_email = TableInfo::from_meta(&TableMeta {
            columns: vec![detail("email", false, false), detail("name", true, false)],
            indexes: vec![unique("u", &["email"])],
            ..Default::default()
        });
        let nullable_unique = TableInfo::from_meta(&TableMeta {
            columns: vec![detail("email", true, false)],
            indexes: vec![unique("u", &["email"])],
            ..Default::default()
        });
        assert_eq!(
            by_email.keys,
            [KeyInfo {
                columns: vec!["email".into()],
                primary: false
            }]
        );
        assert!(
            nullable_unique.keys.is_empty(),
            "a nullable unique column is no key"
        );
        let r = run(
            "postgres",
            "SELECT email FROM people",
            vec![prov("email", "public.people", "email")],
            vec![("people", by_email)],
            None,
        );
        assert_eq!(editable(&r).2, ["email"]);
    }

    /// (spec: result-editing › Two candidates)
    #[test]
    fn a_join_with_both_keys_offers_both_and_defaults_to_the_first_in_from() {
        let sql =
            "SELECT o.id, o.status, u.id, u.name FROM orders o JOIN users u ON u.id = o.user_id";
        let cols = || {
            vec![
                prov("id", "public.orders", "id"),
                prov("status", "public.orders", "status"),
                prov("id", "public.users", "id"),
                prov("name", "public.users", "name"),
            ]
        };
        let tables = || vec![("orders", orders()), ("users", users())];
        let r = run("postgres", sql, cols(), tables(), None);
        assert_eq!(editable(&r).0, &t("public", "orders"));
        let c = candidates(&r);
        assert_eq!(c.len(), 2);
        assert!(c.iter().all(|c| c.available));
        let EditResolution::Editable { columns, .. } = &r else {
            unreachable!()
        };
        assert!(columns[0].editable && columns[1].editable);
        assert!(!columns[2].editable && !columns[3].editable);
        assert!(columns[3]
            .reason
            .as_deref()
            .unwrap()
            .contains("public.users"));

        // Switching the table changes which columns are dimmed.
        let r = run(
            "postgres",
            sql,
            cols(),
            tables(),
            Some(t("public", "users")),
        );
        let (target, map, _, key_idx) = editable(&r);
        assert_eq!(target, &t("public", "users"));
        assert_eq!(map, [None, None, Some("id".into()), Some("name".into())]);
        assert_eq!(key_idx, [2]);
        let EditResolution::Editable { columns, .. } = &r else {
            unreachable!()
        };
        assert!(!columns[0].editable && columns[3].editable);
    }

    /// (spec: result-editing › Two candidates)
    #[test]
    fn candidates_follow_from_order_not_column_order() {
        let r = run(
            "postgres",
            "SELECT u.name, o.id FROM orders o JOIN users u ON u.id = o.user_id",
            vec![
                prov("name", "public.users", "name"),
                prov("id", "public.orders", "id"),
            ],
            vec![("orders", orders()), ("users", users())],
            None,
        );
        let names: Vec<&str> = candidates(&r).iter().map(|c| c.table.as_str()).collect();
        assert_eq!(names, ["orders", "users"]);
        assert_eq!(editable(&r).0.table, "orders");
    }

    /// (spec: result-editing › One candidate)
    #[test]
    fn a_join_with_one_key_chooses_that_table_automatically() {
        let r = run(
            "postgres",
            "SELECT o.id, o.status, u.name FROM orders o JOIN users u ON u.id = o.user_id",
            vec![
                prov("id", "public.orders", "id"),
                prov("status", "public.orders", "status"),
                prov("name", "public.users", "name"),
            ],
            vec![("orders", orders()), ("users", users())],
            None,
        );
        assert_eq!(editable(&r).0.table, "orders");
        let c = candidates(&r);
        assert!(c[0].available);
        assert!(!c[1].available);
        assert_eq!(c[1].missing_keys, ["id"]);
        let EditResolution::Editable { columns, .. } = &r else {
            unreachable!()
        };
        assert!(!columns[2].editable, "u.name is dimmed");
    }

    /// (spec: result-editing › One candidate)
    #[test]
    fn asking_for_an_unavailable_table_falls_back_to_an_available_one() {
        let r = run(
            "postgres",
            "SELECT o.id, u.name FROM orders o JOIN users u ON u.id = o.user_id",
            vec![
                prov("id", "public.orders", "id"),
                prov("name", "public.users", "name"),
            ],
            vec![("orders", orders()), ("users", users())],
            Some(t("public", "users")),
        );
        assert_eq!(editable(&r).0.table, "orders");
    }

    /// (spec: result-editing › Read-only reasons)
    #[test]
    fn a_join_where_no_table_has_its_key_asks_for_the_keys() {
        let r = run(
            "postgres",
            "SELECT o.status, u.name FROM orders o JOIN users u ON u.id = o.user_id",
            vec![
                prov("status", "public.orders", "status"),
                prov("name", "public.users", "name"),
            ],
            vec![("orders", orders()), ("users", users())],
            None,
        );
        let why = reason(&r);
        assert_eq!(why.code, ReadOnlyCode::MultipleTables);
        assert!(why.message.contains("orders: add id") && why.message.contains("users: add id"));
    }

    /// (spec: result-editing › Views)
    #[test]
    fn a_view_is_read_only() {
        let view = TableInfo::from_meta(&TableMeta {
            columns: vec![detail("id", false, false), detail("status", true, false)],
            is_view: Some(true),
            ..Default::default()
        });
        let r = run(
            "postgres",
            "SELECT id, status FROM open_orders",
            vec![
                prov("id", "public.open_orders", "id"),
                prov("status", "public.open_orders", "status"),
            ],
            vec![("open_orders", view)],
            None,
        );
        let why = reason(&r);
        assert_eq!(why.code, ReadOnlyCode::View);
        assert_eq!(why.message, "public.open_orders is a view");
    }

    /// (spec: result-editing › DISTINCT is not editable)
    #[test]
    fn distinct_and_group_by_are_aggregate_results_even_with_provenance() {
        for sql in [
            "SELECT DISTINCT id, status FROM orders",
            "SELECT status, id FROM orders GROUP BY status, id",
            "SELECT id FROM orders UNION SELECT id FROM orders",
        ] {
            let r = run(
                "postgres",
                sql,
                vec![
                    prov("id", "public.orders", "id"),
                    prov("status", "public.orders", "status"),
                ],
                vec![("orders", orders())],
                None,
            );
            let why = reason(&r);
            assert_eq!(why.code, ReadOnlyCode::Aggregate, "{sql}");
            assert_eq!(why.message, "Aggregate or computed result");
        }
    }

    /// (spec: result-editing › DISTINCT is not editable)
    #[test]
    fn distinct_is_not_editable_when_inferred_either() {
        let r = run(
            "oracle",
            "SELECT DISTINCT id, status FROM orders",
            vec![bare("ID"), bare("STATUS")],
            vec![("orders", orders())],
            None,
        );
        assert_eq!(reason(&r).message, "Aggregate or computed result");
    }

    /// (spec: result-editing › Unparseable statement)
    #[test]
    fn an_unparseable_statement_without_provenance_is_unknown() {
        let r = run(
            "oracle",
            "SELECT id FROM orders MODEL DIMENSION BY (x) MEASURES (y) RULES ()",
            vec![bare("ID")],
            vec![("orders", orders())],
            None,
        );
        let why = reason(&r);
        assert_eq!(why.code, ReadOnlyCode::Unknown);
        assert_eq!(
            why.message,
            "Can't tell which table these columns come from"
        );
    }

    /// (spec: result-editing › Unparseable statement)
    #[test]
    fn provenance_still_works_when_the_parser_does_not_know_the_syntax() {
        let r = run(
            "postgres",
            "SELECT id FROM orders TABLESAMPLE SYSTEM_ROWS (10) WHATEVER ((",
            vec![prov("id", "public.orders", "id")],
            vec![("orders", orders())],
            None,
        );
        assert_eq!(editable(&r).0.table, "orders");
    }

    /// (spec: result-editing › Oracle simple select)
    #[test]
    fn oracle_simple_select_is_inferred() {
        let r = run(
            "oracle",
            "SELECT id, status FROM orders",
            vec![bare("ID"), bare("STATUS")],
            vec![("orders", orders())],
            None,
        );
        let EditResolution::Editable {
            inferred,
            target,
            column_map,
            key_columns,
            ..
        } = &r
        else {
            panic!("editable expected, got {r:?}")
        };
        assert!(inferred);
        assert_eq!(
            target.table, "ORDERS",
            "unquoted Oracle names are stored in upper case"
        );
        assert_eq!(
            target.schema.as_deref(),
            Some("public"),
            "the default schema fills in"
        );
        assert_eq!(column_map, &[Some("id".into()), Some("status".into())]);
        assert_eq!(key_columns, &["id"]);
    }

    /// (spec: result-editing › Oracle simple select)
    #[test]
    fn inferred_aliases_wildcards_and_expressions() {
        let r = run(
            "sqlserver",
            "SELECT total AS amount, id AS order_id, total * 2 AS dbl FROM dbo.orders",
            vec![bare("amount"), bare("order_id"), bare("dbl")],
            vec![("orders", orders())],
            None,
        );
        let (target, map, _, key_idx) = editable(&r);
        assert_eq!(target.schema.as_deref(), Some("dbo"));
        assert_eq!(map, [Some("total".into()), Some("id".into()), None]);
        assert_eq!(key_idx, [1]);

        let r = run(
            "duckdb",
            "SELECT * FROM orders",
            vec![
                bare("id"),
                bare("status"),
                bare("total"),
                bare("fingerprint"),
                bare("seq"),
            ],
            vec![("orders", orders())],
            None,
        );
        let EditResolution::Editable {
            columns,
            column_map,
            ..
        } = &r
        else {
            panic!("editable expected")
        };
        assert_eq!(column_map[3].as_deref(), Some("fingerprint"));
        assert!(!columns[3].editable);

        // A column of a wildcard in the middle of other items.
        let r = run(
            "clickhouse",
            "SELECT id, *, total FROM orders",
            vec![
                bare("id"),
                bare("id"),
                bare("status"),
                bare("total"),
                bare("total"),
            ],
            vec![("orders", orders())],
            None,
        );
        assert_eq!(
            editable(&r).1,
            [
                Some("id".into()),
                Some("id".into()),
                Some("status".into()),
                Some("total".into()),
                Some("total".into())
            ]
        );
    }

    /// (spec: result-editing › Source detection)
    #[test]
    fn inference_matches_names_regardless_of_case() {
        let r = run(
            "oracle",
            "SELECT ID, Status FROM orders",
            vec![bare("ID"), bare("STATUS")],
            vec![("orders", orders())],
            None,
        );
        assert_eq!(editable(&r).1, [Some("id".into()), Some("status".into())]);
    }

    /// (spec: result-editing › Source detection)
    #[test]
    fn inference_refuses_joins_and_misaligned_projections() {
        for (sql, cols) in [
            (
                "SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id",
                vec![bare("ID")],
            ),
            ("SELECT id, status FROM orders", vec![bare("ID")]),
            ("SELECT * , * FROM orders", vec![bare("ID"), bare("ID")]),
            ("SELECT id FROM (SELECT id FROM orders)", vec![bare("ID")]),
            (
                "WITH x AS (SELECT 1 id FROM dual) SELECT id FROM x",
                vec![bare("ID")],
            ),
        ] {
            let r = run("oracle", sql, cols, vec![("orders", orders())], None);
            assert_eq!(reason(&r).code, ReadOnlyCode::Unknown, "{sql}");
        }
    }

    /// (spec: result-editing › Key missing)
    #[test]
    fn a_structure_that_cannot_be_read_is_reported() {
        let plan = plan("oracle", None, "SELECT id FROM nope", &[bare("ID")]);
        let loaded: Loaded = vec![Err("the table was not found".into())];
        let r = finish(&plan, &loaded, 1, None);
        let why = reason(&r);
        assert_eq!(why.code, ReadOnlyCode::Unknown);
        assert!(why.message.contains("the table was not found"));
    }

    /// (spec: driver-framework › Result column provenance)
    #[test]
    fn schema_and_table_come_from_the_provenance() {
        let mut c = prov("status", "public.orders", "status");
        c.source_schema = Some("public".into());
        assert_eq!(provenance_table(&c), Some(t("public", "orders")));
        // SQLite and friends: no schema in the name.
        let mut c = prov("x", "t", "x");
        c.source_schema = None;
        c.source_table = Some("t".into());
        assert_eq!(
            provenance_table(&c),
            Some(TableRef {
                schema: None,
                table: "t".into()
            })
        );
    }

    #[test]
    fn introspection_paths_fit_each_driver() {
        let tr = t("sales", "orders");
        let p = table_path("postgres", Some("app"), &tr);
        assert_eq!(p.find(NodeKind::Schema), Some("sales"));
        assert_eq!(p.last().unwrap().name, "orders");
        let p = table_path("mysql", None, &tr);
        assert_eq!(p.find(NodeKind::Database), Some("sales"));
        let p = table_path(
            "sqlite",
            None,
            &TableRef {
                schema: None,
                table: "t".into(),
            },
        );
        assert_eq!(p.find(NodeKind::Database), Some("main"));
        let p = table_path("sqlserver", Some("shop"), &tr);
        assert_eq!(p.find(NodeKind::Database), Some("shop"));
        assert_eq!(p.find(NodeKind::Schema), Some("sales"));
        let p = table_path("oracle", None, &tr);
        assert_eq!(p.find(NodeKind::Schema), Some("sales"));
    }

    #[test]
    fn the_cache_keeps_tables_per_connection() {
        let cache = Cache::default();
        let tr = t("public", "orders");
        assert!(cache.get("c1", &tr).is_none());
        cache.put("c1", &tr, orders());
        assert!(cache.get("c1", &t("PUBLIC", "Orders")).is_some());
        assert!(cache.get("c2", &tr).is_none());
        cache.forget("c1");
        assert!(cache.get("c1", &tr).is_none());
    }
}

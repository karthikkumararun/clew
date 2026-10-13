//! Statement analysis: which table does a `SELECT` read, and which of its columns does each
//! projected item name? Used when the driver reports no provenance (Oracle, SQL Server, ClickHouse,
//! DuckDB) and, for every driver, to spot shapes whose rows are not table rows (DISTINCT, GROUP BY,
//! set operations, window functions).
//!
//! Only one shape is accepted: a single `SELECT` with exactly one table in `FROM` and no join,
//! derived table, CTE, `DISTINCT`, `GROUP BY`, set operation or window function. Anything else, or
//! a statement that does not parse, is [`Analysis::Unsupported`] with a reason code.

use std::ops::ControlFlow;

use sqlparser::ast::{
    visit_expressions, Distinct, Expr, GroupByExpr, Ident, ObjectName, ObjectNamePart, Select,
    SelectItem, SetExpr, Statement, TableFactor, TableWithJoins,
};
use sqlparser::dialect::{
    ClickHouseDialect, Dialect as ParserDialect, DuckDbDialect, GenericDialect, MsSqlDialect,
    MySqlDialect, OracleDialect, PostgreSqlDialect, SQLiteDialect,
};
use sqlparser::parser::Parser;

/// The parser dialect for a driver id (`postgres`, `mysql`, …); anything unknown parses as generic.
pub fn parser_dialect(driver: &str) -> Box<dyn ParserDialect> {
    match driver {
        "postgres" | "postgresql" => Box::new(PostgreSqlDialect {}),
        "mysql" | "mariadb" => Box::new(MySqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        "oracle" => Box::new(OracleDialect {}),
        "sqlserver" | "mssql" => Box::new(MsSqlDialect {}),
        "clickhouse" => Box::new(ClickHouseDialect {}),
        "duckdb" => Box::new(DuckDbDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

/// A table named in `FROM`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableName {
    pub schema: Option<String>,
    pub name: String,
    pub alias: Option<String>,
}

impl TableName {
    /// Does a column qualifier (`o` in `o.id`) refer to this table?
    fn answers_to(&self, qualifier: &str) -> bool {
        match &self.alias {
            Some(a) => a.eq_ignore_ascii_case(qualifier),
            None => self.name.eq_ignore_ascii_case(qualifier),
        }
    }
}

/// One projected item of the `SELECT` list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    /// A plain column reference, optionally qualified and aliased. `output` is the name the
    /// result column carries (the alias, else the column name).
    Column { column: String, output: String },
    /// `*` or `t.*` (the result columns are the table's, by name).
    Wildcard,
    /// Anything else: an expression, a literal, a function call.
    Expr,
}

/// Why a statement is not a plain single-table read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsupported {
    ParseError,
    /// Not one `SELECT` statement.
    NotSelect,
    NoFrom,
    /// A join, or several tables in `FROM`.
    Join,
    /// A derived table, table function or anything else in `FROM` that is not a named table.
    Subquery,
    Cte,
    SetOperation,
    Distinct,
    GroupBy,
    Window,
    /// An aggregate function in the select list.
    Aggregate,
    /// `INTO`, `CONNECT BY`, lateral views and other shapes we do not follow.
    Other,
}

impl Unsupported {
    /// Whether the rows are computed from several table rows (so they are not table rows at all),
    /// as opposed to us just not being able to tell where they come from.
    pub fn is_computed(self) -> bool {
        matches!(
            self,
            Self::SetOperation | Self::Distinct | Self::GroupBy | Self::Window | Self::Aggregate
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Analysis {
    Single {
        table: TableName,
        items: Vec<Item>,
    },
    Unsupported {
        reason: Unsupported,
        /// The named tables found in `FROM` (and joins), in order; empty when nothing parsed.
        tables: Vec<TableName>,
    },
}

impl Analysis {
    /// Tables of the statement in `FROM` order, whatever the verdict.
    pub fn tables(&self) -> Vec<&TableName> {
        match self {
            Self::Single { table, .. } => vec![table],
            Self::Unsupported { tables, .. } => tables.iter().collect(),
        }
    }

    pub fn unsupported(&self) -> Option<Unsupported> {
        match self {
            Self::Unsupported { reason, .. } => Some(*reason),
            Self::Single { .. } => None,
        }
    }
}

fn unsupported(reason: Unsupported, tables: Vec<TableName>) -> Analysis {
    Analysis::Unsupported { reason, tables }
}

fn part(p: &ObjectNamePart) -> Option<String> {
    match p {
        ObjectNamePart::Identifier(i) => Some(i.value.clone()),
        ObjectNamePart::Function(_) => None,
    }
}

/// An object name as the database stores it: unquoted names fold to upper case on Oracle and to
/// lower case on PostgreSQL; quoted names and every other database keep what was written.
fn stored(driver: &str, ident: &Ident) -> String {
    match (ident.quote_style, driver) {
        (Some(_), _) => ident.value.clone(),
        (None, "oracle") => ident.value.to_uppercase(),
        (None, "postgres" | "postgresql") => ident.value.to_lowercase(),
        (None, _) => ident.value.clone(),
    }
}

/// `schema.table`, `catalog.schema.table` or `table`.
fn table_name(driver: &str, name: &ObjectName, alias: Option<&Ident>) -> Option<TableName> {
    let parts: Vec<&Ident> = name
        .0
        .iter()
        .map(|p| match p {
            ObjectNamePart::Identifier(i) => Some(i),
            ObjectNamePart::Function(_) => None,
        })
        .collect::<Option<_>>()?;
    let (table, rest) = parts.split_last()?;
    Some(TableName {
        schema: rest.last().map(|s| stored(driver, s)),
        name: stored(driver, table),
        alias: alias.map(|a| a.value.clone()),
    })
}

/// Every named table of the `FROM` clause, joins included.
fn from_tables(driver: &str, from: &[TableWithJoins]) -> Vec<TableName> {
    let mut out = Vec::new();
    let mut take = |f: &TableFactor| {
        if let TableFactor::Table { name, alias, .. } = f {
            out.extend(table_name(driver, name, alias.as_ref().map(|a| &a.name)));
        }
    };
    for t in from {
        take(&t.relation);
        for j in &t.joins {
            take(&j.relation);
        }
    }
    out
}

/// A function in the select list that makes the row something other than a table row.
fn computed_function(items: &[SelectItem]) -> Option<Unsupported> {
    let mut found = None;
    let _ = visit_expressions(&items.to_vec(), |e| {
        if let Expr::Function(f) = e {
            if f.over.is_some() {
                found = Some(Unsupported::Window);
                return ControlFlow::Break(());
            }
            let name = f
                .name
                .0
                .last()
                .and_then(part)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if matches!(
                name.as_str(),
                "count"
                    | "sum"
                    | "avg"
                    | "min"
                    | "max"
                    | "group_concat"
                    | "string_agg"
                    | "array_agg"
                    | "json_agg"
                    | "jsonb_agg"
                    | "listagg"
                    | "bool_and"
                    | "bool_or"
                    | "stddev"
                    | "variance"
            ) {
                found = Some(Unsupported::Aggregate);
                return ControlFlow::Break(());
            }
        }
        ControlFlow::<()>::Continue(())
    });
    found
}

fn project(items: &[SelectItem], table: &TableName) -> Vec<Item> {
    items
        .iter()
        .map(|item| match item {
            SelectItem::UnnamedExpr(e) => column_item(e, None, table),
            SelectItem::ExprWithAlias { expr, alias } => column_item(expr, Some(alias), table),
            SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(..) => Item::Wildcard,
            SelectItem::ExprWithAliases { .. } => Item::Expr,
        })
        .collect()
}

/// A column reference of `table` (unqualified, or qualified by the table's name or alias).
fn column_item(expr: &Expr, alias: Option<&Ident>, table: &TableName) -> Item {
    let column = match expr {
        Expr::Identifier(id) => id.value.clone(),
        Expr::CompoundIdentifier(parts) if parts.len() >= 2 => {
            let (col, quals) = parts.split_last().expect("two parts");
            let qualifier = &quals[quals.len() - 1].value;
            if !table.answers_to(qualifier) {
                return Item::Expr;
            }
            col.value.clone()
        }
        _ => return Item::Expr,
    };
    Item::Column {
        output: alias.map_or_else(|| column.clone(), |a| a.value.clone()),
        column,
    }
}

fn analyze_select(driver: &str, select: &Select) -> Analysis {
    let tables = from_tables(driver, &select.from);
    let bail = |reason| unsupported(reason, tables.clone());

    if select
        .distinct
        .as_ref()
        .is_some_and(|d| d != &Distinct::All)
    {
        return bail(Unsupported::Distinct);
    }
    let grouped = match &select.group_by {
        GroupByExpr::All(_) => true,
        GroupByExpr::Expressions(exprs, modifiers) => !exprs.is_empty() || !modifiers.is_empty(),
    };
    if grouped || select.having.is_some() {
        return bail(Unsupported::GroupBy);
    }
    if !select.named_window.is_empty() || select.qualify.is_some() {
        return bail(Unsupported::Window);
    }
    if let Some(reason) = computed_function(&select.projection) {
        return bail(reason);
    }
    if select.into.is_some()
        || !select.connect_by.is_empty()
        || !select.lateral_views.is_empty()
        || select.value_table_mode.is_some()
    {
        return bail(Unsupported::Other);
    }
    match select.from.as_slice() {
        [] => bail(Unsupported::NoFrom),
        [one] if one.joins.is_empty() => match &one.relation {
            TableFactor::Table {
                name,
                alias,
                args: None,
                ..
            } => match table_name(driver, name, alias.as_ref().map(|a| &a.name)) {
                Some(table) => {
                    let items = project(&select.projection, &table);
                    Analysis::Single { table, items }
                }
                None => bail(Unsupported::Other),
            },
            TableFactor::Table { .. } => bail(Unsupported::Subquery),
            _ => bail(Unsupported::Subquery),
        },
        _ => bail(Unsupported::Join),
    }
}

/// Analyse one statement for the driver `driver`. Never fails: the verdict says what it found.
pub fn analyze(driver: &str, statement: &str) -> Analysis {
    let dialect = parser_dialect(driver);
    let Ok(mut parsed) = Parser::parse_sql(dialect.as_ref(), statement) else {
        return unsupported(Unsupported::ParseError, vec![]);
    };
    if parsed.len() != 1 {
        return unsupported(Unsupported::NotSelect, vec![]);
    }
    let Statement::Query(query) = parsed.remove(0) else {
        return unsupported(Unsupported::NotSelect, vec![]);
    };
    if query.with.is_some() {
        return unsupported(Unsupported::Cte, vec![]);
    }
    match query.body.as_ref() {
        SetExpr::Select(select) => analyze_select(driver, select),
        SetExpr::SetOperation { .. } => unsupported(Unsupported::SetOperation, vec![]),
        _ => unsupported(Unsupported::Other, vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(column: &str, output: &str) -> Item {
        Item::Column {
            column: column.into(),
            output: output.into(),
        }
    }

    fn reason(a: &Analysis) -> Unsupported {
        a.unsupported()
            .unwrap_or_else(|| panic!("expected unsupported, got {a:?}"))
    }

    #[test]
    fn plain_columns_aliases_and_qualifiers_map_to_table_columns() {
        let a = analyze(
            "oracle",
            "SELECT o.total AS amount, id, o.status FROM sales.orders o WHERE id > 3 ORDER BY id",
        );
        let Analysis::Single { table, items } = a else {
            panic!("single table expected")
        };
        // Oracle stores unquoted names in upper case.
        assert_eq!(table.schema.as_deref(), Some("SALES"));
        assert_eq!(table.name, "ORDERS");
        assert_eq!(table.alias.as_deref(), Some("o"));
        assert_eq!(
            items,
            vec![
                col("total", "amount"),
                col("id", "id"),
                col("status", "status")
            ]
        );
    }

    #[test]
    fn expressions_and_foreign_qualifiers_are_unmapped() {
        let Analysis::Single { items, .. } = analyze(
            "oracle",
            "SELECT id, total * 1.2 AS with_tax, x.name, 1 FROM orders",
        ) else {
            panic!("single table expected")
        };
        assert_eq!(
            items,
            vec![col("id", "id"), Item::Expr, Item::Expr, Item::Expr]
        );
    }

    #[test]
    fn wildcards_are_kept_for_the_resolver() {
        let Analysis::Single { items, .. } = analyze("sqlserver", "SELECT * FROM dbo.orders")
        else {
            panic!("single table expected")
        };
        assert_eq!(items, vec![Item::Wildcard]);
    }

    #[test]
    fn unsupported_shapes_carry_a_reason() {
        let cases = [
            ("SELECT DISTINCT id FROM orders", Unsupported::Distinct),
            (
                "SELECT status, count(*) FROM orders GROUP BY status",
                Unsupported::GroupBy,
            ),
            ("SELECT count(*) FROM orders", Unsupported::Aggregate),
            (
                "SELECT id, row_number() OVER (ORDER BY id) FROM orders",
                Unsupported::Window,
            ),
            (
                "SELECT id FROM a UNION SELECT id FROM b",
                Unsupported::SetOperation,
            ),
            (
                "SELECT a.id FROM a JOIN b ON a.id = b.id",
                Unsupported::Join,
            ),
            ("SELECT a.id FROM a, b", Unsupported::Join),
            (
                "SELECT id FROM (SELECT id FROM orders) s",
                Unsupported::Subquery,
            ),
            (
                "WITH x AS (SELECT id FROM orders) SELECT id FROM x",
                Unsupported::Cte,
            ),
            ("SELECT 1", Unsupported::NoFrom),
            ("UPDATE orders SET a = 1", Unsupported::NotSelect),
            ("SELECT 1 FROM a; SELECT 2 FROM b", Unsupported::NotSelect),
            ("SELEC id FRM orders", Unsupported::ParseError),
        ];
        for (sql, want) in cases {
            assert_eq!(reason(&analyze("oracle", sql)), want, "{sql}");
        }
    }

    #[test]
    fn joins_still_report_their_tables_in_from_order() {
        let a = analyze(
            "postgres",
            "SELECT o.id, u.name FROM orders o JOIN users u ON u.id = o.user_id",
        );
        let names: Vec<&str> = a.tables().iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["orders", "users"]);
    }

    #[test]
    fn only_computed_reasons_say_so() {
        assert!(Unsupported::Distinct.is_computed());
        assert!(Unsupported::SetOperation.is_computed());
        assert!(!Unsupported::ParseError.is_computed());
        assert!(!Unsupported::Join.is_computed());
    }

    #[test]
    fn every_driver_gets_a_dialect() {
        for d in [
            "postgres",
            "mysql",
            "mariadb",
            "sqlite",
            "oracle",
            "sqlserver",
            "clickhouse",
            "duckdb",
            "mongodb",
        ] {
            assert!(
                matches!(analyze(d, "SELECT id FROM t"), Analysis::Single { .. }),
                "{d}"
            );
        }
    }
}

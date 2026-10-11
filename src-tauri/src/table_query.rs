//! The SELECT behind the table editor's Data view: filter, order and page, per dialect. The
//! WHERE and ORDER BY fragments are raw SQL by design (a power-user feature, as in DataGrip);
//! they run on the user's own session with their own privileges.

use serde::{Deserialize, Serialize};

use crate::drivers::introspect::{NodeKind, NodePath};
use crate::exporter::SqlFlavor;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQueryRequest {
    pub path: NodePath,
    /// Raw `WHERE` fragment (without the keyword).
    #[serde(default)]
    pub where_clause: Option<String>,
    /// Raw `ORDER BY` fragment (without the keywords).
    #[serde(default)]
    pub order_by: Option<String>,
    #[ts(type = "number")]
    pub offset: u64,
    /// Rows per page; zero means no paging (every row, for an export).
    #[ts(type = "number")]
    pub limit: u64,
    /// Columns to order by when `order_by` is empty (the primary key).
    #[serde(default)]
    pub default_order: Vec<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQuery {
    /// The page of rows.
    pub select: String,
    /// `SELECT count(*)` with the same filter.
    pub count: String,
    /// The quoted, qualified table name.
    pub table: String,
}

/// `schema.table` (or `database.table`), quoted for the dialect.
pub fn qualified_name(driver: &str, path: &NodePath) -> String {
    let flavor = SqlFlavor::of_driver(driver);
    let table = path.0.last().map(|s| s.name.as_str()).unwrap_or_default();
    // DuckDB can have several catalogs attached, so its names carry the catalog too.
    if driver == "duckdb" || driver == "sqlserver" {
        let parts: Vec<&str> = [
            path.find(NodeKind::Database),
            path.find(NodeKind::Schema),
            Some(table),
        ]
        .into_iter()
        .flatten()
        .collect();
        return parts
            .iter()
            .map(|p| flavor.quote_ident(p))
            .collect::<Vec<_>>()
            .join(".");
    }
    let parent = path.find(NodeKind::Schema).or_else(|| {
        (flavor == SqlFlavor::Mysql || flavor == SqlFlavor::Sqlite)
            .then(|| path.find(NodeKind::Database))
            .flatten()
    });
    match parent {
        Some(p) => format!("{}.{}", flavor.quote_ident(p), flavor.quote_ident(table)),
        None => flavor.quote_ident(table),
    }
}

fn clean(fragment: &Option<String>) -> Option<&str> {
    fragment
        .as_deref()
        .map(str::trim)
        .map(|f| f.trim_end_matches(';').trim())
        .filter(|f| !f.is_empty())
}

pub fn build(driver: &str, req: &TableQueryRequest) -> TableQuery {
    let flavor = SqlFlavor::of_driver(driver);
    let table = qualified_name(driver, &req.path);
    let filter = clean(&req.where_clause)
        .map(|w| format!(" WHERE ({w})"))
        .unwrap_or_default();
    let order = clean(&req.order_by).map(str::to_string).or_else(|| {
        (!req.default_order.is_empty()).then(|| {
            req.default_order
                .iter()
                .map(|c| flavor.quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ")
        })
    });
    let offset_fetch = matches!(flavor, SqlFlavor::Sqlserver | SqlFlavor::Oracle);
    let order_clause = match (&order, flavor) {
        (Some(o), _) => format!(" ORDER BY {o}"),
        // OFFSET needs an ORDER BY on SQL Server; any stable one will do.
        (None, SqlFlavor::Sqlserver) => " ORDER BY (SELECT NULL)".to_string(),
        (None, _) => String::new(),
    };
    let page = if req.limit == 0 {
        String::new()
    } else if offset_fetch {
        format!(
            " OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
            req.offset, req.limit
        )
    } else {
        format!(" LIMIT {} OFFSET {}", req.limit, req.offset)
    };
    TableQuery {
        select: format!("SELECT * FROM {table}{filter}{order_clause}{page}"),
        count: format!("SELECT count(*) FROM {table}{filter}"),
        table,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg_path() -> NodePath {
        NodePath::root()
            .child(NodeKind::Database, "analytics")
            .child(NodeKind::Schema, "public")
            .child(NodeKind::Group, "tables")
            .child(NodeKind::Table, "orders")
    }

    fn req(path: NodePath) -> TableQueryRequest {
        TableQueryRequest {
            path,
            where_clause: None,
            order_by: None,
            offset: 0,
            limit: 100,
            default_order: vec!["id".into()],
        }
    }

    #[test]
    fn postgres_pages_with_limit_offset_and_orders_by_the_key() {
        let q = build("postgres", &req(pg_path()));
        assert_eq!(
            q.select,
            "SELECT * FROM \"public\".\"orders\" ORDER BY \"id\" LIMIT 100 OFFSET 0"
        );
        assert_eq!(q.count, "SELECT count(*) FROM \"public\".\"orders\"");
        assert_eq!(q.table, "\"public\".\"orders\"");
    }

    #[test]
    fn filter_and_order_are_used_as_given_and_the_filter_is_parenthesised() {
        let mut r = req(pg_path());
        r.where_clause = Some("status = 'pending' OR total > 100;".into());
        r.order_by = Some("created_at DESC".into());
        r.offset = 200;
        let q = build("postgres", &r);
        assert_eq!(
            q.select,
            "SELECT * FROM \"public\".\"orders\" WHERE (status = 'pending' OR total > 100) ORDER BY created_at DESC LIMIT 100 OFFSET 200"
        );
        assert_eq!(
            q.count,
            "SELECT count(*) FROM \"public\".\"orders\" WHERE (status = 'pending' OR total > 100)"
        );
    }

    #[test]
    fn blank_fragments_are_ignored() {
        let mut r = req(pg_path());
        r.where_clause = Some("   ;  ".into());
        r.order_by = Some("".into());
        let q = build("postgres", &r);
        assert_eq!(
            q.select,
            "SELECT * FROM \"public\".\"orders\" ORDER BY \"id\" LIMIT 100 OFFSET 0"
        );
    }

    #[test]
    fn mysql_qualifies_with_the_database_and_uses_backticks() {
        let path = NodePath::root()
            .child(NodeKind::Database, "shop")
            .child(NodeKind::Group, "tables")
            .child(NodeKind::Table, "or`ders");
        let q = build("mysql", &req(path));
        assert_eq!(
            q.select,
            "SELECT * FROM `shop`.`or``ders` ORDER BY `id` LIMIT 100 OFFSET 0"
        );
    }

    #[test]
    fn sqlite_qualifies_with_the_database() {
        let path = NodePath::root()
            .child(NodeKind::Database, "main")
            .child(NodeKind::Table, "t");
        let mut r = req(path);
        r.default_order = vec![];
        assert_eq!(
            build("sqlite", &r).select,
            "SELECT * FROM \"main\".\"t\" LIMIT 100 OFFSET 0"
        );
    }

    #[test]
    fn a_zero_limit_means_every_row() {
        let mut r = req(pg_path());
        r.limit = 0;
        r.where_clause = Some("total > 1".into());
        assert_eq!(
            build("postgres", &r).select,
            "SELECT * FROM \"public\".\"orders\" WHERE (total > 1) ORDER BY \"id\""
        );
        let mut ms = req(pg_path());
        ms.limit = 0;
        ms.default_order = vec![];
        assert_eq!(
            build("sqlserver", &ms).select,
            "SELECT * FROM [public].[orders] ORDER BY (SELECT NULL)"
        );
    }

    #[test]
    fn sql_server_and_oracle_page_with_offset_fetch() {
        let path = NodePath::root()
            .child(NodeKind::Database, "shop")
            .child(NodeKind::Schema, "dbo")
            .child(NodeKind::Group, "tables")
            .child(NodeKind::Table, "orders");
        let mut r = req(path.clone());
        r.default_order = vec![];
        r.offset = 50;
        assert_eq!(
            build("sqlserver", &r).select,
            "SELECT * FROM [dbo].[orders] ORDER BY (SELECT NULL) OFFSET 50 ROWS FETCH NEXT 100 ROWS ONLY"
        );
        assert_eq!(
            build("oracle", &r).select,
            "SELECT * FROM \"dbo\".\"orders\" OFFSET 50 ROWS FETCH NEXT 100 ROWS ONLY"
        );
        let with_key = req(path);
        assert!(build("sqlserver", &with_key)
            .select
            .contains("ORDER BY [id] OFFSET"));
    }
}

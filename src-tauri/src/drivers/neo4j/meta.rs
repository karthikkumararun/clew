//! Metadata queries (explorer, completion, the schema sidebar) on the connection's own client,
//! separate from every console session.

use tokio::sync::Mutex;

use super::bolt::conn::{self, failure_error};
use super::bolt::{Client, Ps, Resp};
use crate::drivers::graph::{GraphAccess, GraphCount, GraphSchema, GraphSchemaItem};
use crate::drivers::{DriverError, DriverResult, ErrorCode};

pub(crate) struct Neo4jMeta {
    pub client: Mutex<Client>,
    /// The database from the connection settings (`None` = the user's home database).
    pub default_db: Option<String>,
}

/// One auto-commit READ query, read to the end. A pooled connection the server closed in the
/// meantime is replaced once.
pub(crate) async fn run_read(
    client: &mut Client,
    db: Option<&str>,
    text: &str,
    params: Ps,
) -> DriverResult<Vec<Vec<Ps>>> {
    let mut last = None;
    for _ in 0..2 {
        match run_once(client, db, text, params.clone()).await {
            Err(e) if e.code == ErrorCode::ConnectionLost => last = Some(e),
            other => return other,
        }
    }
    Err(last.expect("two attempts"))
}

async fn run_once(
    client: &mut Client,
    db: Option<&str>,
    text: &str,
    params: Ps,
) -> DriverResult<Vec<Vec<Ps>>> {
    let mut conn = client.acquire(db, GraphAccess::Read).await?;
    let mut extra = vec![("mode".to_string(), Ps::str("r"))];
    if let Some(d) = db {
        extra.push(("db".into(), Ps::str(d)));
    }
    conn.queue(conn::RUN, vec![Ps::str(text), params, Ps::Map(extra)]);
    conn.queue(conn::PULL, vec![Ps::map([("n", Ps::Int(-1))])]);
    let result = async {
        conn.flush().await?;
        conn.expect_success().await?;
        let mut rows = Vec::new();
        loop {
            match conn.recv().await? {
                Resp::Record(values) => rows.push(values),
                Resp::Success(_) => return Ok(rows),
                Resp::Failure { code, message } => {
                    conn.recover().await;
                    return Err(failure_error(&code, &message));
                }
                Resp::Ignored => {
                    conn.recover().await;
                    return Err(DriverError::internal("the server ignored a metadata query"));
                }
            }
        }
    }
    .await;
    client.release(conn);
    result
}

/// `` `name` `` for use in Cypher text.
pub(crate) fn quote(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn text(ps: &Ps) -> String {
    ps.as_str().unwrap_or_default().to_string()
}

fn texts(ps: &Ps) -> Vec<String> {
    ps.as_list()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

/// Labels per query when counting (`UNION ALL` of count-store lookups).
const COUNT_CHUNK: usize = 40;

impl Neo4jMeta {
    pub async fn read(
        &self,
        db: Option<&str>,
        text: &str,
        params: Ps,
    ) -> DriverResult<Vec<Vec<Ps>>> {
        let mut client = self.client.lock().await;
        let r = run_read(&mut client, db, text, params).await;
        if r.as_ref().is_err_and(|e| {
            e.detail
                .as_deref()
                .is_some_and(|d| d.contains("NotALeader") || d.contains("DatabaseUnavailable"))
        }) {
            client.forget_routing();
        }
        r
    }

    fn db<'a>(&'a self, database: Option<&'a str>) -> Option<&'a str> {
        database.or(self.default_db.as_deref())
    }

    /// The databases the user can see, `system` last.
    pub async fn databases(&self) -> DriverResult<Vec<String>> {
        let rows = self
            .read(
                Some("system"),
                "SHOW DATABASES YIELD name RETURN name",
                Ps::Map(vec![]),
            )
            .await;
        let mut names: Vec<String> = match rows {
            Ok(rows) => rows.iter().filter_map(|r| r.first().map(text)).collect(),
            // a user who may not list databases still has the one they connected to
            Err(e) if matches!(e.code, ErrorCode::AccessDenied | ErrorCode::QueryFailed) => self
                .default_db
                .clone()
                .or_else(|| Some("neo4j".to_string()))
                .into_iter()
                .collect(),
            Err(e) => return Err(e),
        };
        names.sort_by(|a, b| (a == "system", a).cmp(&(b == "system", b)));
        names.dedup();
        Ok(names)
    }

    async fn names(&self, db: Option<&str>, query: &str) -> DriverResult<Vec<String>> {
        let rows = self.read(db, query, Ps::Map(vec![])).await?;
        let mut names: Vec<String> = rows
            .iter()
            .filter_map(|r| r.first().map(text))
            .filter(|n| !n.is_empty())
            .collect();
        names.sort();
        names.dedup();
        Ok(names)
    }

    pub async fn label_names(&self, db: Option<&str>) -> DriverResult<Vec<String>> {
        self.names(db, "CALL db.labels() YIELD label RETURN label")
            .await
    }

    pub async fn relationship_type_names(&self, db: Option<&str>) -> DriverResult<Vec<String>> {
        self.names(
            db,
            "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType",
        )
        .await
    }

    /// Counts come from the count store, so they cost the same on a billion nodes. A label that
    /// cannot be counted shows 0.
    async fn counts(
        &self,
        db: Option<&str>,
        names: Vec<String>,
        pattern: fn(&str) -> String,
    ) -> Vec<GraphCount> {
        let mut out = Vec::with_capacity(names.len());
        for chunk in names.chunks(COUNT_CHUNK) {
            let mut query = String::new();
            let mut params = Vec::new();
            for (i, name) in chunk.iter().enumerate() {
                if i > 0 {
                    query.push_str(" UNION ALL ");
                }
                query.push_str(&format!(
                    "{} RETURN $n{i} AS name, count(x) AS c",
                    pattern(name)
                ));
                params.push((format!("n{i}"), Ps::str(name.clone())));
            }
            let counted = self
                .read(db, &query, Ps::Map(params))
                .await
                .unwrap_or_default();
            for name in chunk {
                let count = counted
                    .iter()
                    .find(|r| r.first().is_some_and(|n| n.as_str() == Some(name)))
                    .and_then(|r| r.get(1).and_then(Ps::as_i64))
                    .unwrap_or(0);
                out.push(GraphCount {
                    name: name.clone(),
                    count,
                });
            }
        }
        out
    }

    pub async fn label_counts(&self, db: Option<&str>) -> DriverResult<Vec<GraphCount>> {
        let names = self.label_names(db).await?;
        Ok(self
            .counts(db, names, |n| format!("MATCH (x:{})", quote(n)))
            .await)
    }

    pub async fn relationship_type_counts(
        &self,
        db: Option<&str>,
    ) -> DriverResult<Vec<GraphCount>> {
        let names = self.relationship_type_names(db).await?;
        Ok(self
            .counts(db, names, |n| format!("MATCH ()-[x:{}]->()", quote(n)))
            .await)
    }

    pub async fn indexes(&self, db: Option<&str>) -> DriverResult<Vec<GraphSchemaItem>> {
        let rows = self
            .read(
                db,
                "SHOW INDEXES YIELD name, type, labelsOrTypes, properties, state \
                 RETURN name, type, labelsOrTypes, properties, state ORDER BY name",
                Ps::Map(vec![]),
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| GraphSchemaItem {
                name: r.first().map(text).unwrap_or_default(),
                kind: r.get(1).map(text).unwrap_or_default(),
                labels: r.get(2).map(texts).unwrap_or_default(),
                properties: r.get(3).map(texts).unwrap_or_default(),
                state: r.get(4).map(text).filter(|s| !s.is_empty()),
            })
            .collect())
    }

    pub async fn constraints(&self, db: Option<&str>) -> DriverResult<Vec<GraphSchemaItem>> {
        let rows = self
            .read(
                db,
                "SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties \
                 RETURN name, type, labelsOrTypes, properties ORDER BY name",
                Ps::Map(vec![]),
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| GraphSchemaItem {
                name: r.first().map(text).unwrap_or_default(),
                kind: r.get(1).map(text).unwrap_or_default(),
                labels: r.get(2).map(texts).unwrap_or_default(),
                properties: r.get(3).map(texts).unwrap_or_default(),
                state: None,
            })
            .collect())
    }

    /// Everything the schema sidebar and completion need. The parts a user may not be allowed to
    /// see (indexes, procedure lists) come back empty rather than failing the whole call.
    pub async fn schema(&self, database: Option<&str>) -> DriverResult<GraphSchema> {
        let db = self.db(database);
        let labels = self.label_counts(db).await?;
        let relationship_types = self.relationship_type_counts(db).await.unwrap_or_default();
        let property_keys = self
            .names(
                db,
                "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey",
            )
            .await
            .unwrap_or_default();
        let indexes = self.indexes(db).await.unwrap_or_default();
        let constraints = self.constraints(db).await.unwrap_or_default();
        let functions = self
            .names(db, "SHOW FUNCTIONS YIELD name RETURN name")
            .await
            .unwrap_or_default();
        let procedures = self
            .names(db, "SHOW PROCEDURES YIELD name RETURN name")
            .await
            .unwrap_or_default();
        Ok(GraphSchema {
            labels,
            relationship_types,
            property_keys,
            indexes,
            constraints,
            functions: Some(functions).filter(|f| !f.is_empty()),
            procedures: Some(procedures).filter(|f| !f.is_empty()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_quoted_for_cypher() {
        assert_eq!(quote("User"), "`User`");
        assert_eq!(quote("we`ird"), "`we``ird`");
        assert_eq!(quote("a b"), "`a b`");
    }
}

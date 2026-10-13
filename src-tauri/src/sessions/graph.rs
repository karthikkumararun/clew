//! Graph-family requests (Neo4j) through the session manager: guarded like every other write,
//! recorded in the Sessions panel, and answered from the tab's own session.

use std::sync::Arc;

use super::{now_ms, Emit, SessionEntry, SessionManager};
use crate::drivers::graph::{GraphMode, GraphRequest, GraphResult, GraphSchema};
use crate::drivers::{DriverError, DriverResult, ErrorCode};
use crate::sessions::GuardReport;

enum Op {
    Query(GraphRequest),
    More(String),
    Expand(String, u32),
    Update(String, String, serde_json::Map<String, serde_json::Value>),
}

/// The Cypher the guard judges for a property edit. The session runs the version-specific form
/// (`id()` on Bolt 4); both mean the same.
pub fn update_guard_text(kind: &str) -> &'static str {
    if kind == "relationship" {
        "MATCH ()-[r]->() WHERE elementId(r) = $id SET r += $props RETURN r"
    } else {
        "MATCH (n) WHERE elementId(n) = $id SET n += $props RETURN n"
    }
}

/// The text the guard judges for a query: EXPLAIN runs nothing.
fn guard_text(request: &GraphRequest) -> String {
    match request.mode {
        GraphMode::Explain => format!("EXPLAIN {}", request.cypher),
        _ => request.cypher.clone(),
    }
}

impl SessionManager {
    async fn graph_run(&self, session_id: &str, op: Op, label: &str) -> DriverResult<GraphResult> {
        let entry: Arc<SessionEntry> = self.session(session_id)?;
        let mut st = Self::lock_session(&entry).await;
        Self::touch(&entry);
        // a session whose connection is gone is replaced, like before any statement
        if st.session.as_ref().is_some_and(|s| !s.is_alive()) {
            if let Some(dead) = st.session.take() {
                let _ = dead.close().await;
            }
        }
        if st.session.is_none() {
            let emit: Emit = Arc::new(|_| true);
            Self::reconnect(&entry, &mut st, &emit).await?;
        }
        entry.update(|c| c.statement_started(label, false, now_ms()));
        let result = {
            let session = st.session.as_mut().expect("session present");
            match session.as_graph() {
                None => Err(DriverError::unsupported("Graph operations")),
                Some(graph) => match op {
                    Op::Query(request) => graph.query(request).await,
                    Op::More(cursor) => graph.fetch_more(&cursor).await,
                    Op::Expand(id, limit) => graph.expand(&id, limit).await,
                    Op::Update(id, kind, props) => graph.update_properties(&id, &kind, props).await,
                },
            }
        };
        match &result {
            Ok(_) => entry.update(|c| c.statement_ok(label, false, false, None, now_ms())),
            Err(e) => {
                Self::statement_failed(&entry, &mut st, None, e).await;
                if e.code == ErrorCode::ConnectionLost {
                    st.session = None;
                }
            }
        }
        result
    }

    /// Run Cypher. The guard decides first: a read-only session refuses writes, a connection that
    /// confirms writes asks, and an unfiltered delete on production needs the typed name.
    pub async fn graph_query(
        &self,
        session_id: &str,
        request: GraphRequest,
        token: Option<String>,
    ) -> DriverResult<GraphResult> {
        let entry = self.session(session_id)?;
        let read_only = entry.state.lock().await.read_only;
        self.enforce(
            session_id,
            &entry,
            read_only,
            &guard_text(&request),
            false,
            token.as_deref(),
        )?;
        let label = request.cypher.clone();
        self.graph_run(session_id, Op::Query(request), &label).await
    }

    /// The next batch of an open result. Reading more of a result the guard already allowed.
    pub async fn graph_fetch_more(
        &self,
        session_id: &str,
        cursor_id: &str,
    ) -> DriverResult<GraphResult> {
        self.graph_run(
            session_id,
            Op::More(cursor_id.to_string()),
            "(fetching more records)",
        )
        .await
    }

    /// A node's relationships and neighbours: a READ query.
    pub async fn graph_expand(
        &self,
        session_id: &str,
        element_id: &str,
        limit: u32,
    ) -> DriverResult<GraphResult> {
        self.graph_run(
            session_id,
            Op::Expand(element_id.to_string(), limit),
            "(expanding neighbours)",
        )
        .await
    }

    /// `SET <element> += $props`, through the guard like any other write.
    pub async fn graph_update_properties(
        &self,
        session_id: &str,
        element_id: &str,
        kind: &str,
        properties: serde_json::Map<String, serde_json::Value>,
        token: Option<String>,
    ) -> DriverResult<GraphResult> {
        let entry = self.session(session_id)?;
        let read_only = entry.state.lock().await.read_only;
        self.enforce(
            session_id,
            &entry,
            read_only,
            update_guard_text(kind),
            false,
            token.as_deref(),
        )?;
        self.graph_run(
            session_id,
            Op::Update(element_id.to_string(), kind.to_string(), properties),
            "(editing properties)",
        )
        .await
    }

    /// What the safeguards say about a property edit, before it is sent.
    pub async fn graph_update_safety_check(
        &self,
        session_id: &str,
        kind: &str,
    ) -> DriverResult<GuardReport> {
        self.safety_check(session_id, update_guard_text(kind), false)
            .await
    }

    pub async fn graph_schema(
        &self,
        connection_id: &str,
        database: Option<&str>,
    ) -> DriverResult<GraphSchema> {
        let c = self.connection(connection_id)?;
        c.driver.graph_schema(&c.pool, database).await
    }

    pub async fn graph_databases(&self, connection_id: &str) -> DriverResult<Vec<String>> {
        let c = self.connection(connection_id)?;
        c.driver.graph_databases(&c.pool).await
    }
}

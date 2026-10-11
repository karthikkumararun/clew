use serde::{Deserialize, Serialize};

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Database,
    Schema,
    /// Folder of tables / views / functions / ... under a schema or database.
    Group,
    Table,
    View,
    MaterializedView,
    Function,
    Procedure,
    Sequence,
    Type,
    Trigger,
    Column,
    PrimaryKey,
    ForeignKey,
    Index,
    Synonym,
    Package,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PathSegment {
    pub kind: NodeKind,
    pub name: String,
}

/// Address of a node in the introspection tree. The empty path is the connection root.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodePath(pub Vec<PathSegment>);

impl NodePath {
    pub fn root() -> Self {
        Self(Vec::new())
    }

    pub fn child(&self, kind: NodeKind, name: impl Into<String>) -> Self {
        let mut v = self.0.clone();
        v.push(PathSegment {
            kind,
            name: name.into(),
        });
        Self(v)
    }

    pub fn last(&self) -> Option<&PathSegment> {
        self.0.last()
    }

    /// Name of the nearest ancestor (or self) of the given kind.
    pub fn find(&self, kind: NodeKind) -> Option<&str> {
        self.0
            .iter()
            .rev()
            .find(|s| s.kind == kind)
            .map(|s| s.name.as_str())
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeNode {
    pub path: NodePath,
    pub kind: NodeKind,
    pub name: String,
    /// e.g. a column type or `~12.4k rows`; `access_denied` when the user may not look inside.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
    pub has_children: bool,
    /// Column details; only set for `Column` nodes.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub column: Option<ColumnInfo>,
}

impl TreeNode {
    pub fn new(
        parent: &NodePath,
        kind: NodeKind,
        name: impl Into<String>,
        has_children: bool,
    ) -> Self {
        let name = name.into();
        Self {
            path: parent.child(kind, name.clone()),
            kind,
            name,
            detail: None,
            has_children,
            column: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary_key: bool,
    /// `table.column` this column references.
    pub foreign_key: Option<String>,
}

/// Everything the SQL console needs for completion, in one call.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SchemaSnapshot {
    pub schemas: Vec<SnapshotSchema>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotSchema {
    pub name: String,
    pub tables: Vec<SnapshotTable>,
    pub functions: Vec<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotTable {
    pub name: String,
    /// `Table`, `View` or `MaterializedView`.
    pub kind: NodeKind,
    pub columns: Vec<SnapshotColumn>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotColumn {
    pub name: String,
    pub type_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_build_and_search() {
        let db = NodePath::root().child(NodeKind::Database, "analytics");
        let schema = db.child(NodeKind::Schema, "public");
        let table = schema.child(NodeKind::Table, "orders");
        assert_eq!(table.find(NodeKind::Schema), Some("public"));
        assert_eq!(table.find(NodeKind::Database), Some("analytics"));
        assert_eq!(table.find(NodeKind::View), None);
        assert_eq!(table.last().unwrap().name, "orders");
    }

    #[test]
    fn tree_node_carries_its_full_path() {
        let parent = NodePath::root().child(NodeKind::Database, "d");
        let n = TreeNode::new(&parent, NodeKind::Schema, "public", true).with_detail("x");
        assert_eq!(n.path.0.len(), 2);
        assert_eq!(n.detail.as_deref(), Some("x"));
    }
}

//! Assistant chats in `clew.db`. The panel owns what a message looks like; Rust keeps it as an
//! opaque JSON body next to the ids that order and list it.

use serde::{Deserialize, Serialize};

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub connection_id: String,
    pub title: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    #[ts(type = "number")]
    pub seq: i64,
    /// `user` or `assistant`.
    pub role: String,
    /// JSON text of the message as the panel keeps it.
    pub body: String,
}

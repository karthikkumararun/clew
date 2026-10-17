//! What may leave the machine (spec: ai-providers › Data-sharing policy). The context builder
//! collects candidate items; the policy removes what the settings and the connection's
//! environment forbid, and redacts hostnames and usernames from text that is sent.

use serde::{Deserialize, Serialize};

use super::config::{Privacy, ProductionPolicy};

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    /// SQL dialect and server version: always allowed.
    Dialect,
    /// Table, column and index names and types.
    Schema,
    /// The SQL in the editor and what the user selected.
    Statement,
    /// The last error message.
    Error,
    /// Rows the user attached.
    Rows,
}

/// One piece of context, exactly as it is sent (spec: ai-providers › What was sent).
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextItem {
    pub kind: ItemKind,
    /// Short name for the chip and the "Context sent" list.
    pub label: String,
    pub content: String,
}

/// What the policy allows for one connection.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// `false` when AI is off for this connection.
    pub allowed: bool,
    pub schema: bool,
    pub sql: bool,
    /// Whether rows may be attached.
    pub rows: bool,
    /// The connection is Production: the UI shows its notice.
    pub production: bool,
}

pub const ROWS_REFUSED: &str = "Row data isn't shared for Production connections";
pub const OFF_FOR_PRODUCTION: &str = "AI is off for Production connections";
/// Rows that may be attached to one message.
pub const MAX_ROWS: usize = 20;

pub fn access(privacy: &Privacy, production: bool) -> Access {
    if production {
        return match privacy.production {
            ProductionPolicy::Disabled => Access {
                allowed: false,
                schema: false,
                sql: false,
                rows: false,
                production,
            },
            ProductionPolicy::SchemaOnly => Access {
                allowed: true,
                schema: privacy.schema,
                sql: privacy.sql,
                rows: false,
                production,
            },
            ProductionPolicy::SameAsOthers => Access {
                allowed: true,
                schema: privacy.schema,
                sql: privacy.sql,
                rows: privacy.rows,
                production,
            },
        };
    }
    Access {
        allowed: true,
        schema: privacy.schema,
        sql: privacy.sql,
        rows: privacy.rows,
        production,
    }
}

/// Keep what `access` allows.
pub fn filter(items: Vec<ContextItem>, access: &Access) -> Vec<ContextItem> {
    if !access.allowed {
        return Vec::new();
    }
    items
        .into_iter()
        .filter(|i| match i.kind {
            ItemKind::Dialect => true,
            ItemKind::Schema => access.schema,
            ItemKind::Statement | ItemKind::Error => access.sql,
            ItemKind::Rows => access.rows,
        })
        .collect()
}

/// Replace every occurrence (any case) of a hostname or username in `text`. Values shorter than
/// three characters are left alone: replacing `a` would mangle everything.
pub fn redact(text: &str, hosts: &[String], users: &[String]) -> String {
    let mut out = text.to_string();
    for (values, token) in [(hosts, "<host>"), (users, "<user>")] {
        for v in values.iter().filter(|v| v.chars().count() >= 3) {
            let Ok(re) = regex::Regex::new(&format!("(?i){}", regex::escape(v))) else {
                continue;
            };
            out = re.replace_all(&out, token).into_owned();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: ItemKind) -> ContextItem {
        ContextItem {
            kind,
            label: format!("{kind:?}"),
            content: "x".into(),
        }
    }

    fn all() -> Vec<ContextItem> {
        vec![
            item(ItemKind::Dialect),
            item(ItemKind::Schema),
            item(ItemKind::Statement),
            item(ItemKind::Error),
            item(ItemKind::Rows),
        ]
    }

    fn kinds(items: &[ContextItem]) -> Vec<ItemKind> {
        items.iter().map(|i| i.kind).collect()
    }

    #[test]
    fn defaults_share_schema_and_sql_but_not_rows() {
        let a = access(&Privacy::default(), false);
        assert!(a.allowed && a.schema && a.sql && !a.rows && !a.production);
        let kept = filter(all(), &a);
        assert_eq!(
            kinds(&kept),
            vec![
                ItemKind::Dialect,
                ItemKind::Schema,
                ItemKind::Statement,
                ItemKind::Error
            ]
        );
    }

    /// (spec: ai-providers › Production schema-only)
    #[test]
    fn production_never_shares_rows_by_default_even_when_rows_are_enabled() {
        let privacy = Privacy {
            rows: true,
            ..Privacy::default()
        };
        let a = access(&privacy, true);
        assert!(a.allowed && a.production && !a.rows);
        assert!(!kinds(&filter(all(), &a)).contains(&ItemKind::Rows));
        // The same settings on a development connection do share rows.
        assert!(access(&privacy, false).rows);
    }

    /// (spec: ai-providers › AI disabled on production)
    #[test]
    fn production_can_switch_ai_off_entirely() {
        let privacy = Privacy {
            production: ProductionPolicy::Disabled,
            ..Privacy::default()
        };
        let a = access(&privacy, true);
        assert!(!a.allowed);
        assert!(filter(all(), &a).is_empty());
        assert!(
            access(&privacy, false).allowed,
            "other environments are unaffected"
        );
    }

    #[test]
    fn same_as_other_connections_lets_production_follow_the_toggles() {
        let privacy = Privacy {
            rows: true,
            sql: false,
            production: ProductionPolicy::SameAsOthers,
            ..Privacy::default()
        };
        let a = access(&privacy, true);
        assert!(a.rows && !a.sql);
    }

    #[test]
    fn toggles_remove_their_items() {
        let privacy = Privacy {
            schema: false,
            sql: false,
            ..Privacy::default()
        };
        let kept = filter(all(), &access(&privacy, false));
        assert_eq!(kinds(&kept), vec![ItemKind::Dialect]);
    }

    #[test]
    fn hostnames_and_usernames_are_redacted_in_any_case() {
        let text = r#"connection to server at "DB.Internal.Example.com", port 5432 failed: FATAL: password authentication failed for user "app_reader""#;
        let out = redact(
            text,
            &["db.internal.example.com".to_string()],
            &["app_reader".to_string()],
        );
        assert!(!out.to_lowercase().contains("internal.example"));
        assert!(!out.contains("app_reader"));
        assert!(out.contains("<host>") && out.contains("<user>"));
        assert!(out.contains("port 5432"));
    }

    #[test]
    fn very_short_values_are_not_redacted() {
        assert_eq!(redact("a b c", &[], &["a".to_string()]), "a b c");
    }
}

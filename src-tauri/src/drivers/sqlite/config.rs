use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::SqliteConnectOptions;

use crate::drivers::{DriverError, DriverResult, ErrorCode, ResolvedConfig, Target};

pub const DEFAULT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Databases to `ATTACH` on every connection: `attach:<name>` options mapped to file paths.
pub fn attachments(cfg: &ResolvedConfig) -> Vec<(String, String)> {
    cfg.options
        .iter()
        .filter_map(|(k, v)| {
            k.strip_prefix("attach:")
                .map(|n| (n.to_string(), v.clone()))
        })
        .collect()
}

/// `ATTACH DATABASE '<path>' AS "<name>"` with both parts quoted.
pub fn attach_sql(name: &str, path: &str) -> String {
    format!(
        "ATTACH DATABASE '{}' AS \"{}\"",
        path.replace('\'', "''"),
        name.replace('"', "\"\"")
    )
}

fn busy_timeout(cfg: &ResolvedConfig) -> Duration {
    cfg.options
        .get("busy_timeout_ms")
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_BUSY_TIMEOUT)
}

/// Build sqlx connect options. A missing file is reported as `file_not_found` up front (instead of
/// SQLite's generic "unable to open database file") unless `create_if_missing` is set.
pub fn connect_options(cfg: &ResolvedConfig) -> DriverResult<SqliteConnectOptions> {
    let Target::File {
        path,
        create_if_missing,
        read_only,
    } = &cfg.target
    else {
        return Err(DriverError::unsupported("A network target for SQLite"));
    };
    if !*create_if_missing && !Path::new(path).exists() {
        return Err(DriverError::new(
            ErrorCode::FileNotFound,
            format!("The database file {path} does not exist"),
        ));
    }
    Ok(SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(*create_if_missing)
        .read_only(*read_only || cfg.read_only)
        .busy_timeout(busy_timeout(cfg))
        .foreign_keys(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::TlsConfig;

    fn cfg(path: &str, create: bool) -> ResolvedConfig {
        ResolvedConfig {
            driver: "sqlite".into(),
            target: Target::File {
                path: path.into(),
                create_if_missing: create,
                read_only: false,
            },
            user: None,
            password: None,
            database: None,
            ssh: None,
            tls: TlsConfig::default(),
            connect_timeout_secs: 10,
            query_timeout_secs: None,
            read_only: false,
            options: Default::default(),
            on_connect: vec![],
        }
    }

    #[test]
    fn a_missing_file_is_file_not_found_naming_the_path() {
        let err = connect_options(&cfg("/no/such/dir/x.sqlite", false)).unwrap_err();
        assert_eq!(err.code, ErrorCode::FileNotFound);
        assert!(err.message.contains("/no/such/dir/x.sqlite"));
    }

    #[test]
    fn create_if_missing_skips_the_check() {
        assert!(connect_options(&cfg("/no/such/dir/x.sqlite", true)).is_ok());
    }

    #[test]
    fn network_targets_are_rejected() {
        let mut c = cfg("x", true);
        c.target = Target::Network {
            host: "h".into(),
            port: 1,
        };
        assert_eq!(
            connect_options(&c).unwrap_err().code,
            ErrorCode::Unsupported
        );
    }

    #[test]
    fn attachments_come_from_options_and_are_quoted() {
        let mut c = cfg("x", true);
        c.options
            .insert("attach:logs".into(), "/tmp/it's.db".into());
        c.options.insert("unrelated".into(), "x".into());
        let a = attachments(&c);
        assert_eq!(a, [("logs".to_string(), "/tmp/it's.db".to_string())]);
        assert_eq!(
            attach_sql(&a[0].0, &a[0].1),
            "ATTACH DATABASE '/tmp/it''s.db' AS \"logs\""
        );
    }

    #[test]
    fn the_busy_timeout_defaults_to_five_seconds_and_can_be_overridden() {
        let mut c = cfg("x", true);
        assert_eq!(busy_timeout(&c), Duration::from_secs(5));
        c.options.insert("busy_timeout_ms".into(), "300".into());
        assert_eq!(busy_timeout(&c), Duration::from_millis(300));
    }
}

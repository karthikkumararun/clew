use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};

use crate::drivers::{DriverError, DriverResult, ResolvedConfig, Target, TlsMode};
use crate::transport::tls;

fn ssl_mode(mode: TlsMode) -> MySqlSslMode {
    match mode {
        TlsMode::Disable => MySqlSslMode::Disabled,
        TlsMode::Prefer => MySqlSslMode::Preferred,
        TlsMode::Require => MySqlSslMode::Required,
        TlsMode::VerifyCa => MySqlSslMode::VerifyCa,
        TlsMode::VerifyFull => MySqlSslMode::VerifyIdentity,
    }
}

/// Build sqlx connect options. Sessions run in UTC so `TIMESTAMP` values are unambiguous, and
/// use utf8mb4 so every character round-trips.
pub fn connect_options(cfg: &ResolvedConfig) -> DriverResult<MySqlConnectOptions> {
    tls::validate(&cfg.tls)?;
    let mut opts = match &cfg.target {
        Target::Network { host, port } => MySqlConnectOptions::new().host(host).port(*port),
        Target::Uri { uri } => uri
            .parse::<MySqlConnectOptions>()
            .map_err(|_| DriverError::internal("The connection URI is not a valid MySQL URI"))?,
        Target::File { .. } => return Err(DriverError::unsupported("A file target for MySQL")),
    };
    if let Some(user) = &cfg.user {
        opts = opts.username(user);
    }
    if let Some(password) = &cfg.password {
        opts = opts.password(password.expose());
    }
    if let Some(db) = &cfg.database {
        opts = opts.database(db);
    }
    opts = opts
        .charset("utf8mb4")
        .timezone(Some("+00:00".to_string()))
        .ssl_mode(ssl_mode(cfg.tls.mode));
    if cfg.tls.mode != TlsMode::Disable {
        if let Some(ca) = &cfg.tls.ca_file {
            opts = opts.ssl_ca(ca);
        }
        if let (Some(cert), Some(key)) = (&cfg.tls.client_cert, &cfg.tls.client_key) {
            opts = opts.ssl_client_cert(cert).ssl_client_key(key);
        }
    }
    Ok(opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::{ErrorCode, Secret, TlsConfig};

    fn cfg() -> ResolvedConfig {
        ResolvedConfig {
            driver: "mysql".into(),
            target: Target::Network {
                host: "db.internal".into(),
                port: 3306,
            },
            user: Some("ada".into()),
            password: Some(Secret::new("hunter2")),
            database: Some("shop".into()),
            ssh: None,
            tls: TlsConfig::default(),
            connect_timeout_secs: 10,
            query_timeout_secs: None,
            read_only: false,
            options: Default::default(),
        }
    }

    #[test]
    fn maps_host_port_user_and_database() {
        let o = connect_options(&cfg()).unwrap();
        assert_eq!(o.get_host(), "db.internal");
        assert_eq!(o.get_port(), 3306);
        assert_eq!(o.get_username(), "ada");
        assert_eq!(o.get_database(), Some("shop"));
        assert_eq!(o.get_charset(), "utf8mb4");
    }

    #[test]
    fn tls_modes_map() {
        let mut c = cfg();
        for (mode, expected) in [
            (TlsMode::Disable, MySqlSslMode::Disabled),
            (TlsMode::Prefer, MySqlSslMode::Preferred),
            (TlsMode::Require, MySqlSslMode::Required),
            (TlsMode::VerifyCa, MySqlSslMode::VerifyCa),
            (TlsMode::VerifyFull, MySqlSslMode::VerifyIdentity),
        ] {
            c.tls.mode = mode;
            assert!(
                matches!(connect_options(&c).unwrap().get_ssl_mode(), m if std::mem::discriminant(&m) == std::mem::discriminant(&expected))
            );
        }
    }

    #[test]
    fn a_bad_uri_does_not_echo_it() {
        let mut c = cfg();
        c.target = Target::Uri {
            uri: "::not a uri:: secret:hunter2".into(),
        };
        assert!(!connect_options(&c).unwrap_err().message.contains("hunter2"));
    }

    #[test]
    fn file_targets_and_missing_cas_are_rejected() {
        let mut c = cfg();
        c.target = Target::File {
            path: "x".into(),
            create_if_missing: false,
            read_only: false,
        };
        assert_eq!(
            connect_options(&c).unwrap_err().code,
            ErrorCode::Unsupported
        );
        let mut c = cfg();
        c.tls = TlsConfig {
            mode: TlsMode::VerifyFull,
            ca_file: Some("/no/ca.pem".into()),
            ..Default::default()
        };
        assert_eq!(connect_options(&c).unwrap_err().code, ErrorCode::TlsFailed);
    }
}

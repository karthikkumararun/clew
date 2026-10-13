use std::str::FromStr;

use sqlx::postgres::{PgConnectOptions, PgSslMode};

use crate::drivers::{DriverError, DriverResult, ErrorCode, ResolvedConfig, Target, TlsMode};
use crate::transport::tls;

fn ssl_mode(mode: TlsMode) -> PgSslMode {
    match mode {
        TlsMode::Disable => PgSslMode::Disable,
        TlsMode::Prefer => PgSslMode::Prefer,
        TlsMode::Require => PgSslMode::Require,
        TlsMode::VerifyCa => PgSslMode::VerifyCa,
        TlsMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

/// Build sqlx connect options from a resolved config. Never logs or echoes the password.
pub fn connect_options(cfg: &ResolvedConfig) -> DriverResult<PgConnectOptions> {
    tls::validate(&cfg.tls)?;
    let mut opts = match &cfg.target {
        Target::Network { host, port } => PgConnectOptions::new().host(host).port(*port),
        Target::Uri { uri } => PgConnectOptions::from_str(uri).map_err(|_| {
            DriverError::new(
                ErrorCode::Internal,
                "The connection URI is not a valid PostgreSQL URI",
            )
        })?,
        Target::File { .. } => {
            return Err(DriverError::unsupported("A file target for PostgreSQL"))
        }
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
        .application_name(
            cfg.options
                .get("application_name")
                .map(String::as_str)
                .unwrap_or("Clew"),
        )
        .ssl_mode(ssl_mode(cfg.tls.mode));
    if cfg.tls.mode != TlsMode::Disable {
        if let Some(ca) = &cfg.tls.ca_file {
            opts = opts.ssl_root_cert(ca);
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
    use crate::drivers::{Secret, TlsConfig};

    fn cfg() -> ResolvedConfig {
        ResolvedConfig {
            driver: "postgres".into(),
            target: Target::Network {
                host: "db.internal".into(),
                port: 5432,
            },
            user: Some("ada".into()),
            password: Some(Secret::new("hunter2")),
            database: Some("analytics".into()),
            ssh: None,
            tls: TlsConfig::default(),
            connect_timeout_secs: 10,
            query_timeout_secs: None,
            read_only: false,
            options: Default::default(),
            on_connect: vec![],
            isolation: None,
        }
    }

    #[test]
    fn maps_host_port_user_and_database() {
        let o = connect_options(&cfg()).unwrap();
        assert_eq!(o.get_host(), "db.internal");
        assert_eq!(o.get_port(), 5432);
        assert_eq!(o.get_username(), "ada");
        assert_eq!(o.get_database(), Some("analytics"));
    }

    #[test]
    fn the_password_never_shows_up_in_debug_output() {
        let c = cfg();
        assert!(!format!("{c:?}").contains("hunter2"));
    }

    #[test]
    fn a_bad_uri_does_not_echo_it() {
        let mut c = cfg();
        c.target = Target::Uri {
            uri: "not a uri with secret:hunter2".into(),
        };
        let err = connect_options(&c).unwrap_err();
        assert!(!err.message.contains("hunter2"));
    }

    #[test]
    fn file_targets_are_rejected() {
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
    }

    #[test]
    fn a_missing_ca_file_fails_before_connecting() {
        let mut c = cfg();
        c.tls = TlsConfig {
            mode: TlsMode::VerifyFull,
            ca_file: Some("/no/such/ca.pem".into()),
            ..Default::default()
        };
        assert_eq!(connect_options(&c).unwrap_err().code, ErrorCode::TlsFailed);
    }
}

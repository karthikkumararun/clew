//! Connection URLs: parse a pasted URL into a prefilled draft, and build the (password-free)
//! preview URL shown in the dialog. The TypeScript `buildUrl` mirrors [`build_url`].

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use url::Url;

use super::model::{OracleConnectBy, PasswordMode, Settings, TlsSettings};
use crate::drivers::TlsMode;
use crate::error::{AppError, AppResult};

/// Characters left as-is inside user names, passwords and database names.
const KEEP: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// What a pasted URL turns into. `password` is the one secret that travels to the WebView: the
/// user pasted it a moment ago and the dialog shows it in the password field; it is not saved
/// until they save.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedUrl {
    pub driver: String,
    pub settings: Settings,
    pub tls: TlsSettings,
    pub password: Option<String>,
    pub suggested_name: String,
}

fn bad_scheme() -> AppError {
    AppError::new(
        "unknown_url_scheme",
        "Clew doesn't recognise this URL scheme",
    )
}

fn invalid(why: &str) -> AppError {
    AppError::new(
        "invalid_url",
        format!("That isn't a valid connection URL: {why}"),
    )
}

pub fn default_port(driver: &str) -> Option<u16> {
    Some(match driver {
        "postgres" => 5432,
        "mysql" | "mariadb" => 3306,
        "sqlserver" => 1433,
        "oracle" => 1521,
        "clickhouse" => 8123,
        "mongodb" => 27017,
        "redis" => 6379,
        "neo4j" => 7687,
        _ => return None,
    })
}

fn decode(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}

fn encode(s: &str) -> String {
    utf8_percent_encode(s, KEEP).to_string()
}

fn tls_from_query(query: &[(String, String)]) -> TlsMode {
    let get = |k: &str| {
        query
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.to_ascii_lowercase())
    };
    if let Some(v) = get("sslmode")
        .or_else(|| get("ssl-mode"))
        .or_else(|| get("ssl_mode"))
    {
        return match v.as_str() {
            "disable" | "disabled" | "allow" => TlsMode::Disable,
            "prefer" | "preferred" => TlsMode::Prefer,
            "verify-ca" | "verify_ca" => TlsMode::VerifyCa,
            "verify-full" | "verify_identity" | "verify-identity" => TlsMode::VerifyFull,
            _ => TlsMode::Require,
        };
    }
    for key in ["ssl", "tls", "secure", "encrypt"] {
        if matches!(get(key).as_deref(), Some("true" | "1" | "yes")) {
            return TlsMode::Require;
        }
    }
    TlsMode::Disable
}

/// Split `a=b;c=d` JDBC-style properties.
fn semicolon_props(s: &str) -> Vec<(String, String)> {
    s.split(';')
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

pub fn parse_url(input: &str) -> AppResult<ParsedUrl> {
    let input = input.trim();
    let (scheme, rest) = input.split_once(':').ok_or_else(|| invalid("no scheme"))?;
    let scheme = scheme.to_ascii_lowercase();

    match scheme.as_str() {
        "sqlite" | "duckdb" => {
            let path = rest.strip_prefix("//").unwrap_or(rest);
            if path.is_empty() {
                return Err(invalid("no file path"));
            }
            let path = decode(path);
            let name = std::path::Path::new(&path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            return Ok(ParsedUrl {
                driver: scheme,
                settings: Settings::File {
                    path,
                    create_if_missing: false,
                },
                tls: TlsSettings::default(),
                password: None,
                suggested_name: name,
            });
        }
        "postgres" | "postgresql" | "mysql" | "mariadb" | "sqlserver" | "oracle" | "clickhouse"
        | "mongodb" | "mongodb+srv" | "redis" | "rediss" | "neo4j" | "neo4j+s" | "bolt"
        | "bolt+s" => {}
        _ => return Err(bad_scheme()),
    }

    // sqlserver://host:1433;databaseName=x;user=u;password=p
    let (main, semi) = match input.split_once(';') {
        Some((m, p)) if scheme == "sqlserver" => (m, semicolon_props(p)),
        _ => (input, vec![]),
    };
    let url = Url::parse(main).map_err(|e| invalid(&e.to_string()))?;
    let query: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let driver = match scheme.as_str() {
        "postgresql" => "postgres",
        "mongodb+srv" => "mongodb",
        "rediss" => "redis",
        "neo4j+s" | "bolt" | "bolt+s" => "neo4j",
        other => other,
    }
    .to_string();

    let semi_get = |names: &[&str]| {
        semi.iter()
            .find(|(k, _)| names.iter().any(|n| k.eq_ignore_ascii_case(n)))
            .map(|(_, v)| v.clone())
    };
    let user = match url.username() {
        "" => semi_get(&["user", "username"]),
        u => Some(decode(u)),
    };
    let password = url
        .password()
        .map(decode)
        .or_else(|| semi_get(&["password"]));
    let host = url
        .host_str()
        .map(|h| h.trim_start_matches('[').trim_end_matches(']').to_string());
    let path_db = {
        let p = url.path().trim_start_matches('/');
        (!p.is_empty()).then(|| decode(p))
    };
    let database = path_db.or_else(|| semi_get(&["databaseName", "database"]));

    let mut mode = tls_from_query(&query);
    if mode == TlsMode::Disable && semi_get(&["encrypt"]).as_deref() == Some("true") {
        mode = TlsMode::Require;
    }
    if scheme == "rediss" || scheme.ends_with("+s") {
        mode = TlsMode::Require;
    }

    let need_host = || {
        host.clone()
            .filter(|h| !h.is_empty())
            .ok_or_else(|| invalid("no host"))
    };
    let port = |d: &str| url.port().or_else(|| default_port(d)).unwrap_or(0);
    let mode_pw = PasswordMode::Keychain;

    let (settings, name) = match driver.as_str() {
        "oracle" => {
            let host = need_host()?;
            let connect_by = match query.iter().find(|(k, _)| k == "sid") {
                Some((_, sid)) => OracleConnectBy::Sid { value: sid.clone() },
                None => OracleConnectBy::ServiceName {
                    value: database.clone().unwrap_or_default(),
                },
            };
            let name = database.clone().unwrap_or_else(|| host.clone());
            (
                Settings::Oracle {
                    host,
                    port: port("oracle"),
                    connect_by,
                    user,
                    role: None,
                    wallet_dir: None,
                    password_mode: mode_pw,
                },
                name,
            )
        }
        "mongodb" => {
            let mut stripped = url.clone();
            let _ = stripped.set_password(None);
            let _ = stripped.set_username("");
            let name = need_host()?;
            (
                Settings::Uri {
                    uri: stripped.to_string(),
                    user,
                    password_mode: mode_pw,
                },
                name,
            )
        }
        "redis" => {
            let host = need_host()?;
            let db_index = database
                .as_deref()
                .and_then(|d| d.parse().ok())
                .unwrap_or(0);
            (
                Settings::Keyvalue {
                    host: host.clone(),
                    port: port("redis"),
                    db_index,
                    user,
                    password_mode: mode_pw,
                },
                host,
            )
        }
        "neo4j" => {
            let host = need_host()?;
            let protocol = scheme.clone();
            (
                Settings::Neo4j {
                    protocol,
                    host: host.clone(),
                    port: port("neo4j"),
                    user,
                    database,
                    password_mode: mode_pw,
                },
                host,
            )
        }
        _ => {
            let host = need_host()?;
            let name = match &database {
                Some(db) => format!("{db}@{host}"),
                None => host.clone(),
            };
            (
                Settings::Network {
                    host,
                    port: port(&driver),
                    database,
                    user,
                    password_mode: mode_pw,
                },
                name,
            )
        }
    };

    Ok(ParsedUrl {
        driver,
        settings,
        tls: TlsSettings {
            mode,
            ..Default::default()
        },
        password,
        suggested_name: name,
    })
}

fn bracket(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn userinfo(user: &Option<String>) -> String {
    match user.as_deref().filter(|u| !u.is_empty()) {
        Some(u) => format!("{}@", encode(u)),
        None => String::new(),
    }
}

/// The URL shown in the dialog's preview. Never contains a password. `None` when the settings
/// cannot be written as a URL (e.g. an Oracle TNS alias).
pub fn build_url(driver: &str, settings: &Settings, tls: &TlsSettings) -> Option<String> {
    let query = |pairs: Vec<(&str, String)>| {
        if pairs.is_empty() {
            String::new()
        } else {
            let joined: Vec<String> = pairs.into_iter().map(|(k, v)| format!("{k}={v}")).collect();
            format!("?{}", joined.join("&"))
        }
    };
    let tls_pairs = |driver: &str| -> Vec<(&'static str, String)> {
        if tls.mode == TlsMode::Disable {
            return vec![];
        }
        match driver {
            "postgres" => vec![(
                "sslmode",
                match tls.mode {
                    TlsMode::Prefer => "prefer",
                    TlsMode::Require => "require",
                    TlsMode::VerifyCa => "verify-ca",
                    _ => "verify-full",
                }
                .to_string(),
            )],
            "mysql" | "mariadb" => vec![(
                "ssl-mode",
                match tls.mode {
                    TlsMode::Prefer => "PREFERRED",
                    TlsMode::Require => "REQUIRED",
                    TlsMode::VerifyCa => "VERIFY_CA",
                    _ => "VERIFY_IDENTITY",
                }
                .to_string(),
            )],
            "sqlserver" => vec![("encrypt", "true".to_string())],
            "clickhouse" => vec![("secure", "true".to_string())],
            _ => vec![],
        }
    };

    match settings {
        Settings::Network {
            host,
            port,
            database,
            user,
            ..
        } => {
            let scheme = driver;
            let db = database
                .as_deref()
                .filter(|d| !d.is_empty())
                .map(|d| format!("/{}", encode(d)))
                .unwrap_or_default();
            Some(format!(
                "{scheme}://{}{}:{port}{db}{}",
                userinfo(user),
                bracket(host),
                query(tls_pairs(driver))
            ))
        }
        Settings::Oracle {
            host,
            port,
            connect_by,
            user,
            ..
        } => {
            let (path, pairs) = match connect_by {
                OracleConnectBy::ServiceName { value } => (format!("/{}", encode(value)), vec![]),
                OracleConnectBy::Sid { value } => (String::new(), vec![("sid", encode(value))]),
                _ => return None,
            };
            Some(format!(
                "oracle://{}{}:{port}{path}{}",
                userinfo(user),
                bracket(host),
                query(pairs)
            ))
        }
        Settings::File { path, .. } => Some(format!("{driver}:{path}")),
        Settings::Uri { uri, user, .. } => {
            let mut url = Url::parse(uri).ok()?;
            if let Some(u) = user.as_deref().filter(|u| !u.is_empty()) {
                url.set_username(u).ok()?;
            }
            Some(url.to_string())
        }
        Settings::Keyvalue {
            host,
            port,
            db_index,
            user,
            ..
        } => {
            let scheme = if tls.mode == TlsMode::Disable {
                "redis"
            } else {
                "rediss"
            };
            let db = if *db_index > 0 {
                format!("/{db_index}")
            } else {
                String::new()
            };
            Some(format!(
                "{scheme}://{}{}:{port}{db}",
                userinfo(user),
                bracket(host)
            ))
        }
        Settings::Neo4j {
            protocol,
            host,
            port,
            user,
            database,
            ..
        } => {
            let db = database
                .as_deref()
                .filter(|d| !d.is_empty())
                .map(|d| format!("/{}", encode(d)))
                .unwrap_or_default();
            Some(format!(
                "{protocol}://{}{}:{port}{db}",
                userinfo(user),
                bracket(host)
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net(p: &ParsedUrl) -> (&str, u16, Option<&str>, Option<&str>) {
        match &p.settings {
            Settings::Network {
                host,
                port,
                database,
                user,
                ..
            } => (host, *port, database.as_deref(), user.as_deref()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn postgres_url_with_password_fills_everything() {
        let p = parse_url("postgres://karthik:secret@db.internal:5432/analytics?sslmode=require")
            .unwrap();
        assert_eq!(p.driver, "postgres");
        assert_eq!(
            net(&p),
            ("db.internal", 5432, Some("analytics"), Some("karthik"))
        );
        assert_eq!(p.password.as_deref(), Some("secret"));
        assert_eq!(p.tls.mode, TlsMode::Require);
        assert_eq!(p.suggested_name, "analytics@db.internal");
    }

    #[test]
    fn ports_default_per_driver_and_postgresql_is_an_alias() {
        let p = parse_url("postgresql://h/db").unwrap();
        assert_eq!((p.driver.as_str(), net(&p).1), ("postgres", 5432));
        assert_eq!(net(&parse_url("mysql://h").unwrap()).1, 3306);
        assert_eq!(net(&parse_url("mariadb://h").unwrap()).1, 3306);
        assert_eq!(net(&parse_url("sqlserver://h").unwrap()).1, 1433);
        assert_eq!(net(&parse_url("clickhouse://h").unwrap()).1, 8123);
    }

    #[test]
    fn credentials_are_percent_decoded() {
        let p = parse_url("mysql://we%40ird:p%3Aw%2Fd@h/d").unwrap();
        assert_eq!(net(&p).3, Some("we@ird"));
        assert_eq!(p.password.as_deref(), Some("p:w/d"));
    }

    #[test]
    fn ipv6_hosts_lose_their_brackets() {
        assert_eq!(net(&parse_url("postgres://[::1]:5433/x").unwrap()).0, "::1");
    }

    #[test]
    fn mysql_ssl_mode_maps() {
        let p = parse_url("mysql://h/d?ssl-mode=VERIFY_IDENTITY").unwrap();
        assert_eq!(p.tls.mode, TlsMode::VerifyFull);
    }

    #[test]
    fn sqlserver_jdbc_style_properties() {
        let p = parse_url("sqlserver://h:1444;databaseName=shop;user=sa;password=pw;encrypt=true")
            .unwrap();
        assert_eq!(net(&p), ("h", 1444, Some("shop"), Some("sa")));
        assert_eq!(p.password.as_deref(), Some("pw"));
        assert_eq!(p.tls.mode, TlsMode::Require);
    }

    #[test]
    fn oracle_service_name_and_sid() {
        let p = parse_url("oracle://scott:tiger@db:1521/ORCLPDB1").unwrap();
        match p.settings {
            Settings::Oracle {
                connect_by: OracleConnectBy::ServiceName { value },
                user,
                ..
            } => {
                assert_eq!(value, "ORCLPDB1");
                assert_eq!(user.as_deref(), Some("scott"));
            }
            other => panic!("{other:?}"),
        }
        let p = parse_url("oracle://db?sid=XE").unwrap();
        match p.settings {
            Settings::Oracle {
                connect_by, port, ..
            } => {
                assert_eq!(connect_by, OracleConnectBy::Sid { value: "XE".into() });
                assert_eq!(port, 1521);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn file_databases() {
        let p = parse_url("sqlite:///tmp/app.db").unwrap();
        assert_eq!(p.driver, "sqlite");
        assert_eq!(
            p.settings,
            Settings::File {
                path: "/tmp/app.db".into(),
                create_if_missing: false
            }
        );
        assert_eq!(p.suggested_name, "app");
        assert!(matches!(
            parse_url("duckdb:./a.duckdb").unwrap().settings,
            Settings::File { .. }
        ));
        assert!(parse_url("sqlite:").is_err());
    }

    #[test]
    fn mongodb_keeps_the_uri_but_not_the_password() {
        let p = parse_url("mongodb+srv://me:pw@cluster0.example.net/app?retryWrites=true").unwrap();
        assert_eq!(p.driver, "mongodb");
        assert_eq!(p.password.as_deref(), Some("pw"));
        match p.settings {
            Settings::Uri { uri, user, .. } => {
                assert!(!uri.contains("pw") && !uri.contains("me@"), "{uri}");
                assert!(uri.starts_with("mongodb+srv://cluster0.example.net"));
                assert_eq!(user.as_deref(), Some("me"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn redis_db_index_and_tls() {
        let p = parse_url("rediss://:pw@cache:6380/3").unwrap();
        assert_eq!(p.tls.mode, TlsMode::Require);
        assert_eq!(p.password.as_deref(), Some("pw"));
        match p.settings {
            Settings::Keyvalue {
                host,
                port,
                db_index,
                user,
                ..
            } => {
                assert_eq!(
                    (host.as_str(), port, db_index, user),
                    ("cache", 6380, 3, None)
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn neo4j_protocols() {
        for (url, tls) in [
            ("neo4j://h", TlsMode::Disable),
            ("neo4j+s://h", TlsMode::Require),
            ("bolt://h:7688", TlsMode::Disable),
            ("bolt+s://h", TlsMode::Require),
        ] {
            let p = parse_url(url).unwrap();
            assert_eq!(p.driver, "neo4j");
            assert_eq!(p.tls.mode, tls, "{url}");
            assert!(matches!(p.settings, Settings::Neo4j { .. }));
        }
    }

    #[test]
    fn unknown_scheme_and_garbage_are_errors() {
        let e = parse_url("ftp://h/x").unwrap_err();
        assert_eq!(e.code, "unknown_url_scheme");
        assert_eq!(e.message, "Clew doesn't recognise this URL scheme");
        assert_eq!(parse_url("not a url").unwrap_err().code, "invalid_url");
        assert_eq!(parse_url("nothing").unwrap_err().code, "invalid_url");
        assert_eq!(parse_url("postgres://").unwrap_err().code, "invalid_url");
    }

    #[test]
    fn built_urls_never_contain_the_password_and_round_trip() {
        for url in [
            "postgres://karthik@db.internal:5432/analytics?sslmode=verify-full",
            "mysql://root@localhost:3306/app?ssl-mode=REQUIRED",
            "mariadb://u@h:3307/d",
            "sqlserver://sa@h:1433/shop?encrypt=true",
            "clickhouse://default@h:8123/db?secure=true",
            "oracle://scott@db:1521/ORCLPDB1",
            "oracle://scott@db:1521?sid=XE",
            "redis://cache:6379/2",
            "rediss://u@cache:6380",
            "neo4j+s://neo4j@graph:7687/movies",
            "bolt://graph:7687",
            "postgres://we%40ird@[::1]:5432/d",
        ] {
            let p = parse_url(url).unwrap();
            let built = build_url(&p.driver, &p.settings, &p.tls).unwrap();
            assert_eq!(built, url, "round trip");
        }
        let p = parse_url("postgres://u:topsecret@h/d").unwrap();
        assert!(!build_url(&p.driver, &p.settings, &p.tls)
            .unwrap()
            .contains("topsecret"));
    }

    #[test]
    fn file_and_mongo_urls_build() {
        let p = parse_url("sqlite:/tmp/a.db").unwrap();
        assert_eq!(
            build_url("sqlite", &p.settings, &p.tls).unwrap(),
            "sqlite:/tmp/a.db"
        );
        let p = parse_url("mongodb://me:pw@h:27017/app").unwrap();
        let built = build_url("mongodb", &p.settings, &p.tls).unwrap();
        assert!(built.contains("me@h") && !built.contains("pw"), "{built}");
    }
}

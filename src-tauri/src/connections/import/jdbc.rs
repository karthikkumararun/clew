//! JDBC URLs (DataGrip) into Clew drivers and settings. Credentials embedded in the URL are
//! returned separately so they never stay in the stored settings.

use crate::connections::model::{OracleConnectBy, PasswordMode, Settings, TlsSettings};
use crate::connections::url::{default_port, parse_url};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Jdbc {
    pub driver: String,
    pub settings: Settings,
    pub tls: TlsSettings,
    pub user: Option<String>,
    pub password: Option<String>,
}

fn split_query(rest: &str) -> (&str, Vec<(String, String)>) {
    match rest.split_once('?') {
        Some((base, q)) => (
            base,
            q.split('&')
                .filter_map(|p| p.split_once('='))
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        ),
        None => (rest, vec![]),
    }
}

fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .into_owned()
}

fn split_host_port(s: &str) -> (String, u16) {
    match s.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() => (h.to_string(), p.parse().unwrap()),
        _ => (s.to_string(), default_port("oracle").unwrap_or(1521)),
    }
}

fn oracle(rest: &str) -> Option<Jdbc> {
    // [user/password]@(//)host:port(/service | :SID) | @alias | @(DESCRIPTION=...)
    let (creds, target) = rest.split_once('@')?;
    let (user, password) = match creds.split_once('/') {
        Some((u, p)) if !u.is_empty() => (Some(u.to_string()), Some(p.to_string())),
        _ if !creds.is_empty() => (Some(creds.to_string()), None),
        _ => (None, None),
    };
    let target = target.trim_start_matches("//");
    let (host, port, connect_by) = if target.starts_with('(') {
        (
            String::new(),
            1521,
            OracleConnectBy::EasyConnect {
                value: target.to_string(),
            },
        )
    } else if let Some((hostport, service)) = target.split_once('/') {
        let (host, port) = split_host_port(hostport);
        (
            host,
            port,
            OracleConnectBy::ServiceName {
                value: service.to_string(),
            },
        )
    } else if target.matches(':').count() == 2 {
        // host:port:SID
        let (hostport, sid) = target.rsplit_once(':').expect("two colons");
        let (host, port) = split_host_port(hostport);
        (
            host,
            port,
            OracleConnectBy::Sid {
                value: sid.to_string(),
            },
        )
    } else if target.contains(':') {
        let (host, port) = split_host_port(target);
        (
            host,
            port,
            OracleConnectBy::ServiceName {
                value: String::new(),
            },
        )
    } else {
        (
            String::new(),
            1521,
            OracleConnectBy::TnsAlias {
                value: target.to_string(),
            },
        )
    };
    Some(Jdbc {
        driver: "oracle".into(),
        settings: Settings::Oracle {
            host,
            port,
            connect_by,
            user: user.clone(),
            role: None,
            wallet_dir: None,
            password_mode: PasswordMode::Keychain,
        },
        tls: TlsSettings::default(),
        user,
        password,
    })
}

/// Map a JDBC URL. `None` for URLs Clew has no driver for.
pub fn parse_jdbc(url: &str) -> Option<Jdbc> {
    let rest = url.trim().strip_prefix("jdbc:")?;
    if let Some(r) = rest.strip_prefix("oracle:thin:") {
        return oracle(r);
    }
    // Pull user/password query parameters out before handing the rest to the URL parser.
    let (base, query) = split_query(rest);
    let mut user = query
        .iter()
        .find(|(k, _)| k == "user")
        .map(|(_, v)| decode(v));
    let mut password = query
        .iter()
        .find(|(k, _)| k == "password")
        .map(|(_, v)| decode(v));
    let kept: Vec<String> = query
        .iter()
        .filter(|(k, _)| k != "user" && k != "password")
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    let cleaned = if kept.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", kept.join("&"))
    };
    // neo4j drivers write `neo4j:bolt://…`
    let cleaned = cleaned
        .replacen("neo4j:bolt", "bolt", 1)
        .replacen("neo4j:neo4j", "neo4j", 1);

    let parsed = parse_url(&cleaned).ok()?;
    if user.is_none() {
        user = parsed.settings_user().map(str::to_string);
    }
    if password.is_none() {
        password = parsed.password.clone();
    }
    let mut settings = parsed.settings;
    match &mut settings {
        Settings::Network { user: u, .. }
        | Settings::Keyvalue { user: u, .. }
        | Settings::Neo4j { user: u, .. }
        | Settings::Uri { user: u, .. } => *u = user.clone(),
        _ => {}
    }
    Some(Jdbc {
        driver: parsed.driver,
        settings,
        tls: parsed.tls,
        user,
        password,
    })
}

/// Clew driver for a DataGrip `driver-ref` when the URL isn't usable.
pub fn driver_for_ref(driver_ref: &str) -> Option<&'static str> {
    let r = driver_ref.to_ascii_lowercase();
    Some(match r.as_str() {
        "postgresql" | "postgres" | "redshift" | "cockroachdb" => "postgres",
        "mysql" | "mysql.8" | "mysql_aurora" => "mysql",
        "mariadb" => "mariadb",
        "sqlserver" | "mssql" | "azure" => "sqlserver",
        "oracle" => "oracle",
        "sqlite" => "sqlite",
        "clickhouse" => "clickhouse",
        "duckdb" => "duckdb",
        "mongo" | "mongodb" => "mongodb",
        "redis" => "redis",
        "neo4j" => "neo4j",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::TlsMode;

    fn net(j: &Jdbc) -> (&str, u16, Option<&str>) {
        match &j.settings {
            Settings::Network {
                host,
                port,
                database,
                ..
            } => (host, *port, database.as_deref()),
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn postgres_mysql_and_friends() {
        let j = parse_jdbc("jdbc:postgresql://db.internal:5432/analytics").unwrap();
        assert_eq!(j.driver, "postgres");
        assert_eq!(net(&j), ("db.internal", 5432, Some("analytics")));
        assert_eq!(
            parse_jdbc("jdbc:mysql://billing-db:3306/billing")
                .unwrap()
                .driver,
            "mysql"
        );
        assert_eq!(parse_jdbc("jdbc:mariadb://h/d").unwrap().driver, "mariadb");
        assert_eq!(
            parse_jdbc("jdbc:clickhouse://ch:8123/default")
                .unwrap()
                .driver,
            "clickhouse"
        );
        let ms = parse_jdbc("jdbc:sqlserver://h:1433;databaseName=shop").unwrap();
        assert_eq!(
            (ms.driver.as_str(), net(&ms)),
            ("sqlserver", ("h", 1433, Some("shop")))
        );
    }

    #[test]
    fn credentials_in_the_url_are_extracted() {
        let j = parse_jdbc("jdbc:postgresql://h:5432/db?user=ann&password=p%40ss&sslmode=require")
            .unwrap();
        assert_eq!(j.user.as_deref(), Some("ann"));
        assert_eq!(j.password.as_deref(), Some("p@ss"));
        assert_eq!(j.tls.mode, TlsMode::Require);
        match j.settings {
            Settings::Network { user, .. } => assert_eq!(user.as_deref(), Some("ann")),
            o => panic!("{o:?}"),
        }
        let k = parse_jdbc("jdbc:sqlserver://h;user=sa;password=pw").unwrap();
        assert_eq!(
            (k.user.as_deref(), k.password.as_deref()),
            (Some("sa"), Some("pw"))
        );
    }

    #[test]
    fn oracle_service_name_sid_and_alias() {
        let j = parse_jdbc("jdbc:oracle:thin:@ora.internal:1521/REPORTS").unwrap();
        match &j.settings {
            Settings::Oracle {
                host,
                port,
                connect_by,
                ..
            } => {
                assert_eq!((host.as_str(), *port), ("ora.internal", 1521));
                assert_eq!(
                    *connect_by,
                    OracleConnectBy::ServiceName {
                        value: "REPORTS".into()
                    }
                );
            }
            o => panic!("{o:?}"),
        }
        let sid = parse_jdbc("jdbc:oracle:thin:@ora:1522:ORCL").unwrap();
        match sid.settings {
            Settings::Oracle {
                host,
                port,
                connect_by,
                ..
            } => {
                assert_eq!((host.as_str(), port), ("ora", 1522));
                assert_eq!(
                    connect_by,
                    OracleConnectBy::Sid {
                        value: "ORCL".into()
                    }
                );
            }
            o => panic!("{o:?}"),
        }
        let slashes = parse_jdbc("jdbc:oracle:thin:@//ora:1521/SVC").unwrap();
        assert!(matches!(
            slashes.settings,
            Settings::Oracle {
                connect_by: OracleConnectBy::ServiceName { .. },
                ..
            }
        ));
        let alias = parse_jdbc("jdbc:oracle:thin:@MYALIAS").unwrap();
        assert!(matches!(
            alias.settings,
            Settings::Oracle {
                connect_by: OracleConnectBy::TnsAlias { .. },
                ..
            }
        ));
        let creds = parse_jdbc("jdbc:oracle:thin:scott/tiger@h:1521/S").unwrap();
        assert_eq!(
            (creds.user.as_deref(), creds.password.as_deref()),
            (Some("scott"), Some("tiger"))
        );
    }

    #[test]
    fn file_and_document_databases() {
        let s = parse_jdbc("jdbc:sqlite:/tmp/app.db").unwrap();
        assert_eq!(s.driver, "sqlite");
        assert_eq!(
            s.settings,
            Settings::File {
                path: "/tmp/app.db".into(),
                create_if_missing: false
            }
        );
        assert_eq!(
            parse_jdbc("jdbc:duckdb:/tmp/a.duckdb").unwrap().driver,
            "duckdb"
        );
        assert_eq!(
            parse_jdbc("jdbc:mongodb://h:27017/db").unwrap().driver,
            "mongodb"
        );
        assert_eq!(parse_jdbc("jdbc:redis://h:6379").unwrap().driver, "redis");
    }

    #[test]
    fn unknown_drivers_are_none() {
        assert!(parse_jdbc("jdbc:cassandra://h:9042/ks").is_none());
        assert!(parse_jdbc("postgres://h").is_none());
    }

    #[test]
    fn driver_refs() {
        assert_eq!(driver_for_ref("postgresql"), Some("postgres"));
        assert_eq!(driver_for_ref("mssql"), Some("sqlserver"));
        assert_eq!(driver_for_ref("cassandra"), None);
    }
}

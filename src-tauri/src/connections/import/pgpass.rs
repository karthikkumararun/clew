//! `~/.pgpass`: `hostname:port:database:username:password`, `\:` and `\\` escape.

use crate::connections::model::{
    Advanced, Connection, Environment, PasswordMode, Settings, TlsSettings,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgpassEntry {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
}

fn split_fields(line: &str) -> Vec<String> {
    let mut fields = vec![String::new()];
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    fields.last_mut().unwrap().push(next);
                }
            }
            ':' => fields.push(String::new()),
            c => fields.last_mut().unwrap().push(c),
        }
    }
    fields
}

/// Entries with no wildcard in host, port, database or user; the rest are skipped.
pub fn parse_pgpass(text: &str) -> Vec<PgpassEntry> {
    text.lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .filter_map(|line| {
            let f = split_fields(line);
            if f.len() != 5 || f[..4].iter().any(|x| x == "*" || x.is_empty()) {
                return None;
            }
            Some(PgpassEntry {
                host: f[0].clone(),
                port: f[1].parse().ok()?,
                database: f[2].clone(),
                user: f[3].clone(),
                password: f[4].clone(),
            })
        })
        .collect()
}

pub fn to_connection(e: &PgpassEntry) -> Connection {
    let name = format!("{}@{}", e.database, e.host);
    let environment = Environment::detect(&name);
    Connection {
        id: String::new(),
        name,
        driver: "postgres".into(),
        group_id: None,
        environment,
        settings: Settings::Network {
            host: e.host.clone(),
            port: e.port,
            database: Some(e.database.clone()),
            user: Some(e.user.clone()),
            password_mode: PasswordMode::Keychain,
        },
        ssh: None,
        tls: TlsSettings::default(),
        advanced: Advanced::default(),
        safeguards: environment.default_safeguards(),
        last_used_at: None,
        scripts_dir: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_lines_and_skips_comments_and_wildcards() {
        let text = "# comment\n\
                    db.internal:5432:analytics:karthik:s3cret\n\
                    *:5432:*:*:wild\n\
                    localhost:5432:*:u:p\n\
                    \n\
                    bad:line\n\
                    h2:notaport:d:u:p\n\
                    h3:5433:d3:u3:pw\n";
        let e = parse_pgpass(text);
        assert_eq!(e.len(), 2);
        assert_eq!(
            e[0],
            PgpassEntry {
                host: "db.internal".into(),
                port: 5432,
                database: "analytics".into(),
                user: "karthik".into(),
                password: "s3cret".into()
            }
        );
        assert_eq!(e[1].host, "h3");
    }

    #[test]
    fn escapes_colons_and_backslashes_in_passwords() {
        let e = parse_pgpass("h:5432:d:u:pa\\:ss\\\\word\n");
        assert_eq!(e[0].password, "pa:ss\\word");
    }

    #[test]
    fn builds_a_postgres_connection() {
        let c = to_connection(&parse_pgpass("prod-db:5432:app:ann:pw\n")[0]);
        assert_eq!(c.driver, "postgres");
        assert_eq!(c.name, "app@prod-db");
        assert_eq!(c.environment, Environment::Production);
        assert!(c.safeguards.read_only_by_default);
    }
}

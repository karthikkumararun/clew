//! A small ClickHouse HTTP client: one place that builds requests, applies the connection's
//! settings and turns HTTP failures into driver errors.

use reqwest::{Client as Http, RequestBuilder, Response, StatusCode};

use crate::drivers::{DriverError, DriverResult, ErrorCode, ResolvedConfig, Target, TlsMode};

pub struct Client {
    http: Http,
    base: String,
    user: String,
    password: Option<String>,
    database: Option<String>,
    target: String,
    read_only: bool,
}

/// What a request carries besides its SQL.
#[derive(Default, Clone)]
pub struct Opts<'a> {
    pub session: Option<&'a str>,
    pub query_id: Option<&'a str>,
    pub read_only: bool,
    /// Numbers come back as JSON numbers instead of quoted strings (metadata queries).
    pub plain_numbers: bool,
    /// Hold the response until the statement is done, so the summary header is final (INSERT).
    pub wait: bool,
}

impl Client {
    pub fn new(cfg: &ResolvedConfig) -> DriverResult<Self> {
        let Target::Network { host, port } = &cfg.target else {
            return Err(DriverError::unsupported("A file target for ClickHouse"));
        };
        let tls = cfg.tls.mode != TlsMode::Disable;
        let mut builder = Http::builder().connect_timeout(std::time::Duration::from_secs(
            cfg.connect_timeout_secs.max(1),
        ));
        if tls {
            if let Some(ca) = &cfg.tls.ca_file {
                let pem = std::fs::read(ca).map_err(|e| {
                    DriverError::new(
                        ErrorCode::TlsFailed,
                        format!("Can't read the CA file {ca}: {e}"),
                    )
                })?;
                let cert = reqwest::Certificate::from_pem(&pem).map_err(|e| {
                    DriverError::new(
                        ErrorCode::TlsFailed,
                        format!("{ca} isn't a PEM certificate: {e}"),
                    )
                })?;
                builder = builder.add_root_certificate(cert);
            }
            if matches!(cfg.tls.mode, TlsMode::Prefer | TlsMode::Require) {
                builder = builder.danger_accept_invalid_certs(true);
            }
        }
        let http = builder
            .build()
            .map_err(|e| DriverError::internal(format!("Couldn't create the HTTP client: {e}")))?;
        let host_part = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.clone()
        };
        Ok(Self {
            http,
            base: format!(
                "{}://{host_part}:{port}/",
                if tls { "https" } else { "http" }
            ),
            user: cfg.user.clone().unwrap_or_else(|| "default".into()),
            password: cfg.password.as_ref().map(|p| p.expose().to_string()),
            database: cfg.database.clone().filter(|d| !d.is_empty()),
            target: format!("{host}:{port}"),
            read_only: cfg.read_only,
        })
    }

    pub fn target(&self) -> &str {
        &self.target
    }

    /// The connection's default for new sessions.
    pub fn read_only_default(&self) -> bool {
        self.read_only
    }

    pub fn request(&self, o: &Opts, body: String) -> RequestBuilder {
        let mut query: Vec<(&str, String)> = vec![
            ("output_format_json_quote_decimals", "1".into()),
            (
                "output_format_json_quote_64bit_integers",
                (!o.plain_numbers)
                    .to_string()
                    .replace("true", "1")
                    .replace("false", "0"),
            ),
            ("wait_end_of_query", if o.wait { "1" } else { "0" }.into()),
        ];
        if let Some(db) = &self.database {
            query.push(("database", db.clone()));
        }
        if let Some(s) = o.session {
            query.push(("session_id", s.to_string()));
            query.push(("session_timeout", "3600".into()));
        }
        if let Some(id) = o.query_id {
            query.push(("query_id", id.to_string()));
        }
        if o.read_only {
            query.push(("readonly", "1".into()));
        }
        let rb = self.http.post(&self.base).query(&query).body(body);
        match &self.password {
            Some(p) => rb.basic_auth(&self.user, Some(p)),
            None => rb.basic_auth(&self.user, None::<&str>),
        }
    }

    /// Send, and turn a failed status or a transport problem into a driver error.
    pub async fn send(&self, rb: RequestBuilder, sql: &str) -> DriverResult<Response> {
        let response = rb.send().await.map_err(|e| self.transport_error(e))?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(http_error(status, &body, sql))
    }

    pub fn transport_error(&self, e: reqwest::Error) -> DriverError {
        if e.is_timeout() {
            DriverError::new(
                ErrorCode::Timeout,
                format!("{} didn't answer in time", self.target),
            )
        } else if e.is_connect() {
            DriverError::new(
                ErrorCode::ConnectionLost,
                format!("Could not reach {}: {}", self.target, root_cause(&e)),
            )
        } else {
            DriverError::new(
                ErrorCode::ConnectionLost,
                format!(
                    "The connection to {} failed: {}",
                    self.target,
                    root_cause(&e)
                ),
            )
        }
    }

    /// Run a metadata query and return its rows (`FORMAT JSONCompact`).
    pub async fn rows(&self, sql: &str) -> DriverResult<Vec<Vec<serde_json::Value>>> {
        let opts = Opts {
            plain_numbers: true,
            ..Opts::default()
        };
        let body = format!("{}\nFORMAT JSONCompact", sql.trim().trim_end_matches(';'));
        let response = self.send(self.request(&opts, body), sql).await?;
        let json: serde_json::Value = response.json().await.map_err(|e| {
            DriverError::internal(format!("Unreadable answer from ClickHouse: {e}"))
        })?;
        Ok(json
            .get("data")
            .and_then(|d| d.as_array())
            .map(|rows| {
                rows.iter()
                    .map(|r| r.as_array().cloned().unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Stop a running query by id.
    pub async fn kill(&self, query_id: &str) -> DriverResult<()> {
        let sql = format!(
            "KILL QUERY WHERE query_id = '{}' ASYNC",
            query_id.replace('\'', "''")
        );
        self.send(self.request(&Opts::default(), sql.clone()), &sql)
            .await?;
        Ok(())
    }
}

fn root_cause(e: &reqwest::Error) -> String {
    let mut cause: &dyn std::error::Error = e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    cause.to_string()
}

/// The numeric code in `Code: 62. DB::Exception: …`.
pub fn exception_code(body: &str) -> Option<u32> {
    let rest = body.trim_start().strip_prefix("Code: ")?;
    rest.split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

/// 1-based position in `…failed at position 7 (…)`.
fn exception_position(body: &str) -> Option<u32> {
    let rest = body.split("at position ").nth(1)?;
    rest.split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

/// A readable message: ClickHouse appends its version and a stack-ish suffix to every exception.
fn clean(body: &str) -> String {
    let first = body.lines().next().unwrap_or(body).trim();
    let first = first.split(" (version ").next().unwrap_or(first);
    first.trim().to_string()
}

pub fn http_error(status: StatusCode, body: &str, sql: &str) -> DriverError {
    let code = exception_code(body);
    let kind = match (status, code) {
        (_, Some(516)) | (StatusCode::UNAUTHORIZED, _) => ErrorCode::AuthFailed,
        (_, Some(394)) => ErrorCode::Cancelled,
        (_, Some(497)) | (StatusCode::FORBIDDEN, _) => ErrorCode::AccessDenied,
        (_, Some(159 | 209)) => ErrorCode::Timeout,
        _ => ErrorCode::QueryFailed,
    };
    let mut e = DriverError::new(
        kind,
        if body.trim().is_empty() {
            format!("ClickHouse answered {status}")
        } else {
            clean(body)
        },
    );
    if kind == ErrorCode::QueryFailed {
        e.position = exception_position(body).filter(|p| *p as usize <= sql.chars().count() + 1);
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    const SYNTAX: &str = "Code: 62. DB::Exception: Syntax error: failed at position 1 ('SELEC') (line 1, col 1): SELEC 1. Expected one of: Query. (SYNTAX_ERROR) (version 24.8.14.39 (official build))\n";

    #[test]
    fn codes_and_positions_come_out_of_the_exception_text() {
        assert_eq!(exception_code(SYNTAX), Some(62));
        assert_eq!(exception_position(SYNTAX), Some(1));
        let e = http_error(StatusCode::BAD_REQUEST, SYNTAX, "SELEC 1");
        assert_eq!(e.code, ErrorCode::QueryFailed);
        assert_eq!(e.position, Some(1));
        assert!(e.message.starts_with("Code: 62."));
        assert!(!e.message.contains("(version"));
    }

    #[test]
    fn auth_cancel_and_access_have_their_own_codes() {
        let auth = "Code: 516. DB::Exception: clew: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)";
        assert_eq!(
            http_error(StatusCode::FORBIDDEN, auth, "").code,
            ErrorCode::AuthFailed
        );
        assert_eq!(
            http_error(StatusCode::UNAUTHORIZED, "", "").code,
            ErrorCode::AuthFailed
        );
        let killed = "Code: 394. DB::Exception: Query was cancelled. (QUERY_WAS_CANCELLED)";
        assert_eq!(
            http_error(StatusCode::INTERNAL_SERVER_ERROR, killed, "").code,
            ErrorCode::Cancelled
        );
        let denied = "Code: 497. DB::Exception: clew: Not enough privileges. (ACCESS_DENIED)";
        assert_eq!(
            http_error(StatusCode::FORBIDDEN, denied, "").code,
            ErrorCode::AccessDenied
        );
        assert_eq!(
            http_error(StatusCode::INTERNAL_SERVER_ERROR, "", "").message,
            "ClickHouse answered 500 Internal Server Error"
        );
    }
}

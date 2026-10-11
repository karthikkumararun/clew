//! Just enough of the MongoDB connection string to put an SSH tunnel in front of it: find the
//! first host, and point the string at the tunnel's local port instead.

use crate::drivers::{DriverError, DriverResult, ErrorCode};

struct Parts<'a> {
    scheme: &'a str,
    userinfo: &'a str,
    hosts: &'a str,
    rest: &'a str,
}

fn split(uri: &str) -> DriverResult<Parts<'_>> {
    let (scheme, after) = uri.split_once("://").ok_or_else(|| {
        DriverError::new(ErrorCode::QueryFailed, "Not a MongoDB connection string")
    })?;
    let end = after.find(['/', '?']).unwrap_or(after.len());
    let (authority, rest) = after.split_at(end);
    let (userinfo, hosts) = match authority.rfind('@') {
        Some(i) => (&authority[..=i], &authority[i + 1..]),
        None => ("", authority),
    };
    Ok(Parts {
        scheme,
        userinfo,
        hosts,
        rest,
    })
}

/// The first host and port of a `mongodb://` string. `mongodb+srv://` has none to tunnel to.
pub fn first_host(uri: &str) -> DriverResult<(String, u16)> {
    let p = split(uri)?;
    if p.scheme.eq_ignore_ascii_case("mongodb+srv") {
        return Err(DriverError::new(
            ErrorCode::Unsupported,
            "An SSH tunnel can't be used with a mongodb+srv:// address; use a mongodb:// one",
        ));
    }
    let first = p.hosts.split(',').next().unwrap_or_default();
    let (host, port) = match first.rsplit_once(':') {
        // an IPv6 literal like [::1] has colons of its own
        Some((h, port)) if !port.contains(']') => (
            h.trim_matches(['[', ']']).to_string(),
            port.parse::<u16>().map_err(|_| {
                DriverError::new(ErrorCode::QueryFailed, format!("Not a port: {port}"))
            })?,
        ),
        _ => (first.trim_matches(['[', ']']).to_string(), 27017),
    };
    if host.is_empty() {
        return Err(DriverError::new(
            ErrorCode::QueryFailed,
            "The connection string has no host",
        ));
    }
    Ok((host, port))
}

/// The same string, pointed at one local address and told not to look for other members (they
/// would be names only the far side of the tunnel can resolve).
pub fn through_tunnel(uri: &str, host: &str, port: u16) -> DriverResult<String> {
    let p = split(uri)?;
    let (path, query) = match p.rest.split_once('?') {
        Some((path, q)) => (path, Some(q)),
        None => (p.rest, None),
    };
    let mut options: Vec<String> = query
        .map(|q| {
            q.split('&')
                .filter(|o| {
                    !o.is_empty() && !o.to_ascii_lowercase().starts_with("directconnection=")
                })
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    options.push("directConnection=true".into());
    Ok(format!(
        "{}://{}{host}:{port}{path}?{}",
        p.scheme,
        p.userinfo,
        options.join("&")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_first_host() {
        assert_eq!(
            first_host("mongodb://u:p@db1.internal:27018,db2:27017/shop?replicaSet=rs0").unwrap(),
            ("db1.internal".into(), 27018)
        );
        assert_eq!(first_host("mongodb://db1/").unwrap(), ("db1".into(), 27017));
        assert_eq!(
            first_host("mongodb://[::1]:27019").unwrap(),
            ("::1".into(), 27019)
        );
        assert!(first_host("mongodb+srv://cluster0.example.net/app").is_err());
        assert!(first_host("postgres").is_err());
    }

    #[test]
    fn points_the_string_at_the_tunnel() {
        assert_eq!(
            through_tunnel(
                "mongodb://u@db1:27018,db2:27017/shop?replicaSet=rs0&directConnection=false",
                "127.0.0.1",
                50111
            )
            .unwrap(),
            "mongodb://u@127.0.0.1:50111/shop?replicaSet=rs0&directConnection=true"
        );
        assert_eq!(
            through_tunnel("mongodb://db1", "127.0.0.1", 1).unwrap(),
            "mongodb://127.0.0.1:1?directConnection=true"
        );
    }
}

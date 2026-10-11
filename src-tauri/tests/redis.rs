//! Redis driver tests. Need `docker compose up -d --wait redis`.
//! Run with `cargo test --features integration`.
#![cfg(feature = "integration")]

mod conformance;

use clew_lib::drivers::introspect::NodePath;
use clew_lib::drivers::nosql::{KvReply, KvRequest, RedisValue};
use clew_lib::drivers::registry::Registry;
use clew_lib::drivers::{ErrorCode, ResolvedConfig, Session, Target, TlsConfig};
use clew_lib::safety::guard::{Decision, Policy};
use conformance::{connect, run_script};

const PORT: u16 = 63791;

fn cfg(read_only: bool) -> ResolvedConfig {
    ResolvedConfig {
        driver: "redis".into(),
        target: Target::Network {
            host: "127.0.0.1".into(),
            port: PORT,
        },
        user: None,
        password: None,
        database: None,
        ssh: None,
        tls: TlsConfig::default(),
        connect_timeout_secs: 5,
        query_timeout_secs: None,
        read_only,
        options: Default::default(),
        on_connect: vec![],
    }
}

async fn open(read_only: bool) -> Box<dyn Session> {
    Registry::with_defaults()
        .get("redis")
        .unwrap()
        .open(&cfg(read_only))
        .await
        .unwrap()
}

async fn kv(s: &mut Box<dyn Session>, r: KvRequest) -> KvReply {
    s.as_keyvalue().unwrap().call(r).await.unwrap()
}

/// Run a console line on the given database and return the reply.
async fn run(s: &mut Box<dyn Session>, db: u32, line: &str) -> RedisValue {
    match kv(
        s,
        KvRequest::Command {
            db,
            line: line.into(),
        },
    )
    .await
    {
        KvReply::Reply { value } => value,
        other => panic!("{other:?}"),
    }
}

fn text(s: &str) -> RedisValue {
    RedisValue::Text { value: s.into() }
}

/// Each test owns a logical database, so they can run in parallel.
async fn clean(db: u32) -> Box<dyn Session> {
    let mut s = open(false).await;
    run(&mut s, db, "FLUSHDB").await;
    s
}

#[tokio::test]
async fn test_connection_reports_the_server() {
    let info = Registry::with_defaults()
        .get("redis")
        .unwrap()
        .test(&cfg(false))
        .await
        .unwrap();
    assert_eq!(info.product, "Redis");
    assert!(info.version.starts_with('7'), "{info:?}");
}

#[tokio::test]
async fn scan_is_incremental_and_reports_types_and_ttls() {
    const DB: u32 = 1;
    let mut s = clean(DB).await;
    for i in 0..250 {
        run(&mut s, DB, &format!("SET session:{i} v{i}")).await;
    }
    run(&mut s, DB, "HSET rate:ip:1.2.3.4 hits 3").await;
    run(&mut s, DB, "EXPIRE session:1 1000").await;
    let mut cursor = String::new();
    let mut seen = Vec::new();
    let mut rounds = 0;
    loop {
        let KvReply::Keys { cursor: next, keys } = kv(
            &mut s,
            KvRequest::Scan {
                db: DB,
                pattern: "*".into(),
                cursor: cursor.clone(),
                count: 50,
                type_filter: None,
            },
        )
        .await
        else {
            panic!()
        };
        seen.extend(keys);
        rounds += 1;
        if next == "0" {
            break;
        }
        cursor = next;
    }
    assert!(rounds > 1, "one SCAN round returned everything");
    assert_eq!(seen.len(), 251);
    let h = seen.iter().find(|k| k.name == "rate:ip:1.2.3.4").unwrap();
    assert_eq!(h.type_name, "hash");
    assert_eq!(h.ttl_ms, None);
    let ttl = seen
        .iter()
        .find(|k| k.name == "session:1")
        .unwrap()
        .ttl_ms
        .unwrap();
    assert!(ttl > 900_000 && ttl <= 1_000_000, "{ttl}");
    // glob filter and TYPE filter
    let KvReply::Keys { keys, .. } = kv(
        &mut s,
        KvRequest::Scan {
            db: DB,
            pattern: "rate:*".into(),
            cursor: "".into(),
            count: 1000,
            type_filter: Some("hash".into()),
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(keys.len(), 1);
}

#[tokio::test]
async fn databases_list_keyspace_sizes() {
    const DB: u32 = 2;
    let mut s = clean(DB).await;
    run(&mut s, DB, "SET a 1").await;
    let KvReply::Databases { items, databases } = kv(&mut s, KvRequest::Databases).await else {
        panic!()
    };
    assert_eq!(databases, 16);
    assert!(items.contains(&(DB, 1)));
}

#[tokio::test]
async fn viewers_page_every_type() {
    const DB: u32 = 3;
    let mut s = clean(DB).await;
    run(&mut s, DB, "SET str hello").await;
    run(&mut s, DB, "HSET h plan free seats 3").await;
    for i in 0..1200 {
        run(&mut s, DB, &format!("RPUSH big {i}")).await;
    }
    run(&mut s, DB, "SADD set b a c").await;
    run(&mut s, DB, "ZADD z 3 c 1 a 2 b").await;
    run(&mut s, DB, "XADD st 1-1 k v").await;
    run(&mut s, DB, "XADD st 2-1 k w").await;
    let page = |key: &str, ty: &str, pos: &str, count: u32| KvRequest::Page {
        db: DB,
        key: key.into(),
        type_name: ty.into(),
        position: pos.into(),
        count,
    };
    let KvReply::Page { rows, .. } = kv(&mut s, page("str", "string", "", 500)).await else {
        panic!()
    };
    assert_eq!(rows, vec![vec![text("hello")]]);
    let KvReply::Page { rows, total, .. } = kv(&mut s, page("h", "hash", "", 500)).await else {
        panic!()
    };
    assert_eq!(total, Some(2));
    assert!(rows.contains(&vec![text("plan"), text("free")]));
    // list: chunks of 500
    let KvReply::Page { rows, next, total } = kv(&mut s, page("big", "list", "", 500)).await else {
        panic!()
    };
    assert_eq!((rows.len(), total), (500, Some(1200)));
    let next = next.unwrap();
    let KvReply::Page { rows, next, .. } = kv(&mut s, page("big", "list", &next, 500)).await else {
        panic!()
    };
    assert_eq!(rows[0], vec![text("500")]);
    let KvReply::Page {
        rows, next: end, ..
    } = kv(&mut s, page("big", "list", &next.unwrap(), 500)).await
    else {
        panic!()
    };
    assert_eq!((rows.len(), end), (200, None));
    let KvReply::Page { rows, .. } = kv(&mut s, page("z", "zset", "", 500)).await else {
        panic!()
    };
    assert_eq!(rows[0][0], text("a"));
    assert_eq!(rows[2][0], text("c"));
    let KvReply::Page { rows, .. } = kv(&mut s, page("set", "set", "", 500)).await else {
        panic!()
    };
    assert_eq!(rows.len(), 3);
    // streams: latest first
    let KvReply::Page { rows, .. } = kv(&mut s, page("st", "stream", "", 500)).await else {
        panic!()
    };
    assert_eq!(rows[0][0], text("2-1"));
    assert_eq!(rows[1][0], text("1-1"));
}

#[tokio::test]
async fn inspect_reports_ttl_size_and_encoding() {
    const DB: u32 = 4;
    let mut s = clean(DB).await;
    run(&mut s, DB, "RPUSH l a b c").await;
    run(&mut s, DB, "EXPIRE l 100").await;
    let KvReply::Key { detail } = kv(
        &mut s,
        KvRequest::Inspect {
            db: DB,
            key: "l".into(),
        },
    )
    .await
    else {
        panic!()
    };
    let d = detail.unwrap();
    assert_eq!((d.type_name.as_str(), d.size), ("list", 3));
    assert!(d.ttl_ms.unwrap() > 90_000);
    assert!(d.encoding.is_some());
    let KvReply::Key { detail } = kv(
        &mut s,
        KvRequest::Inspect {
            db: DB,
            key: "nope".into(),
        },
    )
    .await
    else {
        panic!()
    };
    assert!(detail.is_none());
}

#[tokio::test]
async fn console_replies_are_typed() {
    const DB: u32 = 5;
    let mut s = clean(DB).await;
    assert_eq!(
        run(&mut s, DB, "SET k \"hello world\"").await,
        RedisValue::Status { value: "OK".into() }
    );
    assert_eq!(run(&mut s, DB, "GET k").await, text("hello world"));
    assert_eq!(run(&mut s, DB, "GET missing").await, RedisValue::Nil);
    assert_eq!(
        run(&mut s, DB, "INCR n").await,
        RedisValue::Int { value: 1 }
    );
    assert!(matches!(
        run(&mut s, DB, "RPUSH l a b").await,
        RedisValue::Int { value: 2 }
    ));
    assert!(
        matches!(run(&mut s, DB, "LRANGE l 0 -1").await, RedisValue::Array { items } if items.len() == 2)
    );
    run(&mut s, DB, "HSET s:42 plan free").await;
    assert!(matches!(
        run(&mut s, DB, "HGETALL s:42").await,
        RedisValue::Map { .. } | RedisValue::Array { .. }
    ));
    // an error is a reply, not a failure
    let RedisValue::Error { message } = run(&mut s, DB, "INCR k").await else {
        panic!()
    };
    assert!(message.contains("not an integer"), "{message}");
    // binary-safe
    run(&mut s, DB, "SET bin \"\\xff\\x00\\x10\"").await;
    assert!(matches!(
        run(&mut s, DB, "GET bin").await,
        RedisValue::Bytes { len: 3, .. }
    ));
}

#[tokio::test]
async fn blocking_commands_are_refused() {
    const DB: u32 = 6;
    let mut s = clean(DB).await;
    for line in [
        "MONITOR",
        "SUBSCRIBE news",
        "BLPOP q 0",
        "XREAD BLOCK 0 STREAMS s $",
    ] {
        let e = s
            .as_keyvalue()
            .unwrap()
            .call(KvRequest::Command {
                db: DB,
                line: line.into(),
            })
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Unsupported, "{line}");
    }
    // with a timeout it is fine
    assert_eq!(run(&mut s, DB, "BLPOP q 1").await, RedisValue::Nil);
}

#[tokio::test]
async fn read_only_sessions_refuse_writes_only() {
    const DB: u32 = 7;
    let mut s = clean(DB).await;
    run(&mut s, DB, "SET k v").await;
    s.set_read_only(true).await.unwrap();
    for line in ["SET k x", "DEL k", "FLUSHDB", "HSET h a b", "EXPIRE k 5"] {
        let e = s
            .as_keyvalue()
            .unwrap()
            .call(KvRequest::Command {
                db: DB,
                line: line.into(),
            })
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::ReadOnly, "{line}");
    }
    assert_eq!(run(&mut s, DB, "GET k").await, text("v"));
    s.set_read_only(false).await.unwrap();
    assert_eq!(run(&mut s, DB, "DEL k").await, RedisValue::Int { value: 1 });
}

#[tokio::test]
async fn command_names_for_completion() {
    let mut s = open(false).await;
    let KvReply::Commands { names } = kv(&mut s, KvRequest::Commands).await else {
        panic!()
    };
    assert!(names.iter().any(|n| n.eq_ignore_ascii_case("hgetall")));
    assert!(names.len() > 100);
}

#[tokio::test]
async fn bad_host_and_introspection() {
    const DB: u32 = 9;
    let driver = Registry::with_defaults().get("redis").unwrap();
    let mut bad = cfg(false);
    bad.target = Target::Network {
        host: "127.0.0.1".into(),
        port: 1,
    };
    bad.connect_timeout_secs = 1;
    assert_eq!(
        driver.test(&bad).await.unwrap_err().code,
        ErrorCode::ConnectionLost
    );
    let pool = driver.open_meta_pool(&cfg(false)).await.unwrap();
    let mut s = clean(DB).await;
    run(&mut s, DB, "SET a 1").await;
    let nodes = driver.introspect(&pool, &NodePath::root()).await.unwrap();
    assert!(nodes.iter().any(|n| n.name == "db0"));
    assert!(nodes.iter().any(|n| n.name == format!("db{DB}")));
}

// ---- the console -----------------------------------------------------------------------------------

async fn console(db: u32) -> conformance::Connected {
    let c = connect(&cfg(false)).await;
    c.run(&format!("SELECT {db}")).await.ok();
    c.run("FLUSHDB").await.ok();
    c
}

#[tokio::test]
async fn console_replies_become_tables() {
    let c = console(10).await;
    c.run("HSET session:42 plan pro seats 3").await.ok();
    let r = c.run("HGETALL session:42").await;
    r.ok();
    let names: Vec<_> = r.columns().iter().map(|c| c.name.clone()).collect();
    assert_eq!(names, ["field", "value"]);
    assert_eq!(r.rows().len(), 2);

    let r = c.run("GET nothing").await;
    r.ok();
    assert_eq!(r.rows(), vec![vec![clew_lib::drivers::Value::Null]]);

    c.run("RPUSH l a b c").await.ok();
    let r = c.run("LRANGE l 0 -1").await;
    assert_eq!(r.rows().len(), 3);
    assert_eq!(conformance::int(&r.rows()[2][0]), 3);

    let r = c.run("INCR n").await;
    assert_eq!(r.scalar_int(), 1);
}

#[tokio::test]
async fn a_server_error_is_the_statements_error() {
    let c = console(11).await;
    c.run("SET k v").await.ok();
    let r = c.run("INCR k").await;
    assert!(r.err().message.contains("not an integer"), "{:?}", r.err());
}

#[tokio::test]
async fn select_moves_the_console_and_a_script_runs_a_line_each() {
    let c = console(12).await;
    let r = run_script(
        &c.mgr,
        &c.session,
        "# set up\nSET a 1\nSELECT 13\nSET b 2\nGET b",
        false,
    )
    .await;
    r.ok();
    // `a` is in database 12, `b` in 13
    assert_eq!(
        c.run("GET b").await.rows()[0][0],
        clew_lib::drivers::Value::text("2")
    );
    c.run("SELECT 12").await.ok();
    assert_eq!(
        c.run("GET a").await.rows()[0][0],
        clew_lib::drivers::Value::text("1")
    );
    assert_eq!(c.run("EXISTS b").await.scalar_int(), 0);
}

#[tokio::test]
async fn blocking_commands_are_refused_in_the_console() {
    let c = console(14).await;
    for line in ["MONITOR", "SUBSCRIBE news", "BLPOP q 0"] {
        let r = c.run(line).await;
        assert_eq!(r.err().code, ErrorCode::Unsupported, "{line}");
    }
}

#[tokio::test]
async fn flushdb_on_production_needs_the_connection_name_typed() {
    let c = console(15).await;
    c.run("SET k v").await.ok();
    c.mgr
        .set_policy("conf", Policy::managed("prod-redis", "production", false));
    let report = c
        .mgr
        .safety_check(&c.session, "FLUSHDB", false)
        .await
        .unwrap();
    assert_eq!(report.decision, Decision::TypedConfirm);
    assert_eq!(report.typed.as_deref(), Some("prod-redis"));
    assert_eq!(
        report.statements[0].danger.as_deref(),
        Some("Delete every key in this database?")
    );
    assert_eq!(
        c.run("FLUSHDB").await.err().code,
        ErrorCode::ConfirmationRequired
    );
    assert_eq!(
        c.run("GET k").await.rows()[0][0],
        clew_lib::drivers::Value::text("v")
    );
    // a plain read needs nothing
    let read = c
        .mgr
        .safety_check(&c.session, "GET k", false)
        .await
        .unwrap();
    assert_eq!(read.decision, Decision::Allow);
    // DEL with a pattern is dangerous too
    let del = c
        .mgr
        .safety_check(&c.session, "DEL session:*", false)
        .await
        .unwrap();
    assert_eq!(del.decision, Decision::TypedConfirm);
    // read-only sessions refuse writes
    c.mgr
        .set_policy("conf", Policy::managed("local-redis", "local", false));
    c.mgr.set_session_read_only(&c.session, true).await.unwrap();
    assert_eq!(c.run("SET k x").await.err().code, ErrorCode::ReadOnly);
    assert!(c.run("GET k").await.result.is_ok());
}

#[tokio::test]
async fn an_ssh_tunnel_reaches_the_server_redis() {
    use clew_lib::drivers::{Secret, SshAuth, SshConfig};
    use clew_lib::transport::hostkey::{HostKeyPrompt, HostKeyPrompter, KnownHosts};
    use clew_lib::transport::ssh::SshEnv;

    struct Yes;
    #[async_trait::async_trait]
    impl HostKeyPrompter for Yes {
        async fn confirm(&self, _: HostKeyPrompt) -> bool {
            true
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let env = SshEnv {
        known_hosts: KnownHosts {
            user_file: None,
            app_file: dir.path().join("kh"),
        },
        prompter: std::sync::Arc::new(Yes),
    };
    let mgr = std::sync::Arc::new(clew_lib::sessions::SessionManager::new(
        std::sync::Arc::new(Registry::with_defaults()),
        env,
    ));
    let mut cfg = cfg(false);
    // the compose service name, resolvable from the bastion only
    cfg.target = Target::Network {
        host: "redis".into(),
        port: 6379,
    };
    cfg.ssh = Some(SshConfig {
        host: "127.0.0.1".into(),
        port: 2222,
        user: "tunnel".into(),
        auth: SshAuth::Password {
            password: Secret::new("tunnelpw"),
        },
    });
    let info = mgr
        .test_connection(&cfg)
        .await
        .expect("test through the tunnel");
    assert_eq!(info.product, "Redis");
    mgr.connect("t", cfg)
        .await
        .expect("connect through the tunnel");
    let opened = mgr.open_session("t").await.expect("open");
    assert_eq!(opened.transport.as_deref(), Some("via SSH 127.0.0.1"));
}

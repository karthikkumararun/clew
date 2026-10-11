//! Classifying MongoDB shell commands and Redis console lines, so the same guard that protects
//! SQL sessions (read-only, confirm, typed confirmation on production) protects them too.

use mongodb::bson::Bson;

use super::classify::{StatementClass, StatementInfo};
use crate::drivers::mongodb::shell::{self, Command};

fn info(text: &str, class: StatementClass, danger: Option<String>) -> Vec<StatementInfo> {
    vec![StatementInfo {
        text: text.trim().to_string(),
        class,
        danger,
    }]
}

fn empty_filter(args: &[Bson]) -> bool {
    match args.first() {
        None => true,
        Some(Bson::Document(d)) => d.is_empty(),
        _ => false,
    }
}

pub fn classify_mongo(text: &str) -> Vec<StatementInfo> {
    use StatementClass::*;
    let cmd = match shell::parse_command(text) {
        Ok(c) => c,
        // The driver reports the syntax error; nothing runs, so nothing needs guarding.
        Err(_) => return info(text, Read, None),
    };
    match cmd {
        Command::ShowCollections | Command::ShowDatabases => info(text, Read, None),
        Command::Use(_) => info(text, Control, None),
        Command::Database { .. } => info(text, Read, None),
        Command::Collection {
            collection, call, ..
        } => {
            let (class, danger) = match call.name.as_str() {
                "find"
                | "findOne"
                | "countDocuments"
                | "estimatedDocumentCount"
                | "distinct"
                | "getIndexes" => (Read, None),
                "aggregate" => {
                    let writes = matches!(call.args.first(), Some(Bson::Array(stages))
                        if stages.iter().any(|s| matches!(s, Bson::Document(d)
                            if d.contains_key("$out") || d.contains_key("$merge"))));
                    (if writes { Write } else { Read }, None)
                }
                "insertOne" | "insertMany" | "replaceOne" | "updateOne" | "deleteOne" => {
                    (Write, None)
                }
                "updateMany" => (
                    Write,
                    empty_filter(&call.args)
                        .then(|| format!("Update every document in {collection}?")),
                ),
                "deleteMany" => (
                    Write,
                    empty_filter(&call.args)
                        .then(|| format!("Delete every document in {collection}?")),
                ),
                "createIndex" | "dropIndex" => (Ddl, None),
                "drop" => (Ddl, Some(format!("Drop the collection {collection}?"))),
                _ => (Unknown, None),
            };
            info(text, class, danger)
        }
    }
}

/// Commands that only read, by name. Anything not listed counts as a write.
const READ: &[&str] = &[
    "GET",
    "MGET",
    "STRLEN",
    "GETRANGE",
    "SUBSTR",
    "LCS",
    "EXISTS",
    "TYPE",
    "TTL",
    "PTTL",
    "EXPIRETIME",
    "PEXPIRETIME",
    "KEYS",
    "SCAN",
    "RANDOMKEY",
    "DBSIZE",
    "DUMP",
    "HGET",
    "HMGET",
    "HGETALL",
    "HKEYS",
    "HVALS",
    "HLEN",
    "HEXISTS",
    "HSTRLEN",
    "HSCAN",
    "HRANDFIELD",
    "LLEN",
    "LRANGE",
    "LINDEX",
    "LPOS",
    "SCARD",
    "SMEMBERS",
    "SISMEMBER",
    "SMISMEMBER",
    "SRANDMEMBER",
    "SSCAN",
    "SINTER",
    "SUNION",
    "SDIFF",
    "SINTERCARD",
    "ZCARD",
    "ZRANGE",
    "ZRANGEBYSCORE",
    "ZRANGEBYLEX",
    "ZREVRANGE",
    "ZREVRANGEBYSCORE",
    "ZREVRANGEBYLEX",
    "ZSCORE",
    "ZMSCORE",
    "ZRANK",
    "ZREVRANK",
    "ZCOUNT",
    "ZLEXCOUNT",
    "ZSCAN",
    "ZRANDMEMBER",
    "ZINTER",
    "ZUNION",
    "ZDIFF",
    "XLEN",
    "XRANGE",
    "XREVRANGE",
    "XREAD",
    "XPENDING",
    "PFCOUNT",
    "GETBIT",
    "BITCOUNT",
    "BITPOS",
    "GEODIST",
    "GEOPOS",
    "GEOHASH",
    "GEOSEARCH",
    "SORT_RO",
    "INFO",
    "PING",
    "ECHO",
    "TIME",
    "LASTSAVE",
    "COMMAND",
    "HELLO",
    "DBSIZE",
    "PUBSUB",
    "WAITAOF_NONE",
];

/// Commands whose reads and writes are told apart by their first argument.
const SUB_READ: &[(&str, &[&str])] = &[
    ("CONFIG", &["GET"]),
    ("CLIENT", &["LIST", "INFO", "GETNAME", "ID"]),
    ("SLOWLOG", &["GET", "LEN"]),
    ("MEMORY", &["USAGE", "STATS", "DOCTOR"]),
    (
        "OBJECT",
        &["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"],
    ),
    ("XINFO", &["STREAM", "GROUPS", "CONSUMERS", "HELP"]),
    ("ACL", &["WHOAMI", "LIST", "USERS", "GETUSER", "CAT"]),
    ("LATENCY", &["LATEST", "HISTORY", "DOCTOR"]),
    ("FUNCTION", &["LIST", "STATS"]),
    ("SCRIPT", &["EXISTS"]),
];

/// Commands that only switch what the connection looks at.
const CONTROL: &[&str] = &[
    "SELECT", "MULTI", "DISCARD", "WATCH", "UNWATCH", "AUTH", "RESET",
];

/// The command lines of Redis console text: blank lines and `#` comments are skipped.
pub fn redis_lines(text: &str) -> Vec<&str> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

/// Classify console text of either NoSQL driver: Mongo commands end at `;`, Redis at line ends.
pub fn classify_script(driver: &str, text: &str, script: bool) -> Vec<StatementInfo> {
    match (driver, script) {
        ("redis", true) => redis_lines(text)
            .into_iter()
            .flat_map(classify_redis)
            .collect(),
        ("mongodb", true) => crate::drivers::split::split(text, None)
            .into_iter()
            .flat_map(|s| classify_mongo(&s.text))
            .collect(),
        ("redis", false) => classify_redis(text),
        _ => classify_mongo(text),
    }
}

pub fn classify_redis(line: &str) -> Vec<StatementInfo> {
    use StatementClass::*;
    let args = crate::drivers::redis::commands::tokenize(line).unwrap_or_default();
    let Some(name) = args.first().map(|n| n.to_ascii_uppercase()) else {
        return info(line, Read, None);
    };
    let sub = args.get(1).map(|s| s.to_ascii_uppercase());
    let (class, danger) = if CONTROL.contains(&name.as_str()) {
        (Control, None)
    } else if name == "FLUSHDB" {
        (
            Write,
            Some("Delete every key in this database?".to_string()),
        )
    } else if name == "FLUSHALL" {
        (
            Write,
            Some("Delete every key in every database?".to_string()),
        )
    } else if matches!(name.as_str(), "DEL" | "UNLINK") {
        let pattern = args
            .iter()
            .skip(1)
            .find(|k| k.contains(['*', '?', '[']))
            .cloned();
        (
            Write,
            pattern.map(|p| format!("Delete the keys matching {p}?")),
        )
    } else if READ.contains(&name.as_str()) {
        (Read, None)
    } else if let Some((_, reads)) = SUB_READ.iter().find(|(n, _)| *n == name) {
        if sub.as_deref().is_some_and(|s| reads.contains(&s)) {
            (Read, None)
        } else {
            (Write, None)
        }
    } else if name == "SORT" {
        let stores = args.iter().any(|a| a.eq_ignore_ascii_case("STORE"));
        (if stores { Write } else { Read }, None)
    } else {
        (Write, None)
    };
    info(line, class, danger)
}

/// The shell text a document request amounts to, for guarding and for the confirmation dialog.
/// `None` for requests that only read.
pub fn doc_safety_text(request: &crate::drivers::nosql::DocRequest) -> Option<String> {
    use crate::drivers::nosql::DocRequest as R;
    match request {
        R::Shell { text, .. } => Some(text.clone()),
        R::Aggregate {
            collection,
            pipeline,
            ..
        } => Some(format!("db.{collection}.aggregate({})", pipeline.trim())),
        R::Insert {
            collection,
            documents,
            ..
        } => Some(format!(
            "db.{collection}.insertMany(/* {} documents */)",
            documents.len()
        )),
        R::Replace { collection, id, .. } | R::Update { collection, id, .. } => Some(format!(
            "db.{collection}.updateOne({{ _id: {} }}, /* the edited fields */)",
            id
        )),
        R::Delete {
            collection, ids, ..
        } => Some(format!(
            "db.{collection}.deleteMany({{ _id: {{ $in: /* {} ids */ [] }} }})",
            ids.len()
        )),
        R::CreateIndex {
            collection, keys, ..
        } => Some(format!("db.{collection}.createIndex({})", keys.trim())),
        R::DropIndex {
            collection, name, ..
        } => Some(format!("db.{collection}.dropIndex(\"{name}\")")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StatementClass::*;

    fn m(s: &str) -> (StatementClass, Option<String>) {
        let v = classify_mongo(s);
        (v[0].class, v[0].danger.clone())
    }
    fn r(s: &str) -> (StatementClass, Option<String>) {
        let v = classify_redis(s);
        (v[0].class, v[0].danger.clone())
    }

    #[test]
    fn mongo_reads_writes_and_dangers() {
        assert_eq!(m("db.events.find({})").0, Read);
        assert_eq!(m("db.events.aggregate([{ $match: {} }])").0, Read);
        assert_eq!(m("db.events.aggregate([{ $out: 'x' }])").0, Write);
        assert_eq!(m("show collections").0, Read);
        assert_eq!(m("use shop").0, Control);
        assert_eq!(m("db.events.insertOne({ a: 1 })").0, Write);
        assert_eq!(m("db.events.deleteOne({ a: 1 })"), (Write, None));
        assert_eq!(
            m("db.events.deleteMany({})"),
            (Write, Some("Delete every document in events?".into()))
        );
        assert_eq!(m("db.events.deleteMany({ a: 1 })"), (Write, None));
        assert!(m("db.events.updateMany({}, { $set: { a: 1 } })")
            .1
            .is_some());
        assert_eq!(m("db.events.createIndex({ a: 1 })").0, Ddl);
        assert_eq!(
            m("db.events.drop()"),
            (Ddl, Some("Drop the collection events?".into()))
        );
        assert_eq!(m("db.events.mapReduce()").0, Unknown);
        // unparsable text runs nothing
        assert_eq!(m("for (;;) {}").0, Read);
    }

    #[test]
    fn requests_become_guardable_text() {
        use crate::drivers::nosql::DocRequest as R;
        let text = doc_safety_text(&R::Delete {
            database: "shop".into(),
            collection: "events".into(),
            ids: vec![serde_json::json!(1), serde_json::json!(2)],
        })
        .unwrap();
        let v = classify_mongo(&text);
        assert_eq!((v[0].class, v[0].danger.clone()), (Write, None));
        let text = doc_safety_text(&R::DropIndex {
            database: "shop".into(),
            collection: "events".into(),
            name: "a_1".into(),
        })
        .unwrap();
        assert_eq!(classify_mongo(&text)[0].class, Ddl);
        assert!(doc_safety_text(&R::Databases).is_none());
    }

    #[test]
    fn redis_reads_writes_and_dangers() {
        assert_eq!(r("GET k").0, Read);
        assert_eq!(r("hgetall session:42").0, Read);
        assert_eq!(r("SET k v").0, Write);
        assert_eq!(r("HSET session:42 plan pro").0, Write);
        assert_eq!(r("SELECT 3").0, Control);
        assert_eq!(r("CONFIG GET maxmemory").0, Read);
        assert_eq!(r("CONFIG SET maxmemory 1").0, Write);
        assert_eq!(r("SORT k").0, Read);
        assert_eq!(r("SORT k STORE dst").0, Write);
        assert_eq!(r("EVAL \"return 1\" 0").0, Write);
        assert_eq!(
            r("FLUSHDB"),
            (Write, Some("Delete every key in this database?".into()))
        );
        assert!(r("flushall").1.is_some());
        assert_eq!(r("DEL a b"), (Write, None));
        assert_eq!(
            r("DEL session:*"),
            (Write, Some("Delete the keys matching session:*?".into()))
        );
    }
}

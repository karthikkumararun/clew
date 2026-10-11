//! A MongoDB session: the document operations of [`DocumentSession`], with open cursors kept
//! between pages.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::IndexOptions;
use mongodb::{Client, Cursor, IndexModel};
use serde_json::{json, Value as Json};
use tokio::sync::Notify;

use super::ejson::{doc_from_json, doc_to_json, from_json, to_json};
use super::shell::{self, Call, Command};
use super::{map_err, schema, tabular};
use crate::drivers::nosql::{DocReply, DocRequest, ExportFormat, FieldCheck, IndexInfo};
use crate::drivers::{
    CancelFn, CancelHandle, DocumentSession, DriverError, DriverResult, ErrorCode, ExecRequest,
    ExecSummary, ResultEvent, ResultId, ResultSink, ServerInfo, Session,
};

struct Open {
    cursor: Cursor<Document>,
    /// A document read ahead to learn whether more remain.
    peeked: Option<Document>,
}

pub struct MongoSession {
    client: Client,
    info: ServerInfo,
    default_db: Option<String>,
    read_only: bool,
    timeout: Option<Duration>,
    next_result: ResultId,
    /// A `Mutex` only to make the session `Sync`; it is never contended or held across an await.
    cursors: std::sync::Mutex<HashMap<ResultId, Open>>,
    /// Console results, which also stream as grid rows: their column names, for later pages.
    tabular: HashMap<ResultId, Vec<String>>,
    /// Set while the console runs a command: its results also stream as grid rows.
    tabular_mode: bool,
    cancel: Arc<Notify>,
}

struct Canceller(Arc<Notify>);

#[async_trait]
impl CancelFn for Canceller {
    async fn cancel(&self) -> DriverResult<()> {
        self.0.notify_waiters();
        Ok(())
    }
}

fn parse_err(field: &str, e: shell::ParseError) -> DriverError {
    // `with_position` is for SQL; over IPC only the detail survives, so carry it there too.
    DriverError::new(ErrorCode::QueryFailed, format!("{field}: {}", e.message))
        .with_position(e.position as u32)
        .with_detail(format!("position:{}", e.position))
}

fn read_only_err() -> DriverError {
    DriverError::new(
        ErrorCode::ReadOnly,
        "This session is read-only; writes are refused.",
    )
}

impl MongoSession {
    pub fn new(
        client: Client,
        info: ServerInfo,
        default_db: Option<String>,
        read_only: bool,
        timeout: Option<Duration>,
    ) -> Self {
        Self {
            client,
            info,
            default_db,
            read_only,
            timeout,
            next_result: 1,
            cursors: std::sync::Mutex::new(HashMap::new()),
            tabular: HashMap::new(),
            tabular_mode: false,
            cancel: Arc::new(Notify::new()),
        }
    }

    fn coll(&self, db: &str, coll: &str) -> mongodb::Collection<Document> {
        self.client.database(db).collection(coll)
    }

    fn guard_write(&self) -> DriverResult<()> {
        if self.read_only {
            Err(read_only_err())
        } else {
            Ok(())
        }
    }

    /// Race `fut` against the cancel signal.
    async fn cancellable<T>(
        &self,
        fut: impl std::future::Future<Output = DriverResult<T>>,
    ) -> DriverResult<T> {
        let cancel = self.cancel.clone();
        let notified = cancel.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        tokio::select! {
            r = fut => r,
            _ = &mut notified => Err(DriverError::new(ErrorCode::Cancelled, "Cancelled")),
        }
    }

    async fn page(open: &mut Open, n: usize) -> DriverResult<(Vec<Document>, bool)> {
        let mut docs = Vec::with_capacity(n.min(1024));
        if let Some(d) = open.peeked.take() {
            docs.push(d);
        }
        while docs.len() < n {
            if !open.cursor.advance().await.map_err(map_err)? {
                return Ok((docs, false));
            }
            docs.push(open.cursor.deserialize_current().map_err(map_err)?);
        }
        let more = open.cursor.advance().await.map_err(map_err)?;
        if more {
            open.peeked = Some(open.cursor.deserialize_current().map_err(map_err)?);
        }
        Ok((docs, more))
    }

    /// Send a page of documents. Console results also go out as grid rows (the first page
    /// with the columns), so every later page of one result has the same columns.
    async fn emit_docs(&mut self, sink: &ResultSink, result_id: ResultId, docs: Vec<Document>) {
        if self.tabular_mode || self.tabular.contains_key(&result_id) {
            if self.tabular_mode && !self.tabular.contains_key(&result_id) {
                // a new console result replaces the ones before it
                self.tabular.clear();
                let names = tabular::column_names(&docs);
                sink.send(ResultEvent::Columns {
                    result_id,
                    statement: 0,
                    columns: tabular::columns(&names, &docs),
                })
                .await;
                self.tabular.insert(result_id, names);
            }
            let names = self.tabular.get(&result_id).cloned().unwrap_or_default();
            sink.send(ResultEvent::Rows {
                result_id,
                rows: tabular::rows(&names, &docs),
            })
            .await;
        }
        sink.send(ResultEvent::Documents {
            result_id,
            docs: docs.into_iter().map(doc_to_json).collect(),
        })
        .await;
    }

    /// Stream the first page of `cursor` to the sink and keep the rest for `fetch_more`.
    async fn begin(
        &mut self,
        cursor: Cursor<Document>,
        page_size: usize,
        sink: &ResultSink,
        started: Instant,
        database: Option<String>,
    ) -> DriverResult<DocReply> {
        let result_id = self.next_result;
        self.next_result += 1;
        // only the newest result stays open
        self.cursors.get_mut().unwrap().clear();
        let mut open = Open {
            cursor,
            peeked: None,
        };
        let (docs, has_more) = Self::page(&mut open, page_size.max(1)).await?;
        if has_more {
            self.cursors.get_mut().unwrap().insert(result_id, open);
        }
        self.emit_docs(sink, result_id, docs).await;
        Ok(DocReply::Found {
            result_id,
            has_more,
            elapsed_ms: started.elapsed().as_millis() as u64,
            database,
        })
    }

    /// Send fixed documents as a finished one-page result.
    async fn literal(
        &mut self,
        docs: Vec<Document>,
        sink: &ResultSink,
        started: Instant,
        database: Option<String>,
    ) -> DocReply {
        let result_id = self.next_result;
        self.next_result += 1;
        self.emit_docs(sink, result_id, docs).await;
        DocReply::Found {
            result_id,
            has_more: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
            database,
        }
    }

    #[allow(clippy::too_many_arguments)] // the query bar's fields, passed through as they are
    async fn find(
        &mut self,
        database: &str,
        collection: &str,
        filter: Document,
        projection: Document,
        sort: Document,
        skip: u64,
        limit: u64,
        page_size: usize,
        sink: &ResultSink,
    ) -> DriverResult<DocReply> {
        let started = Instant::now();
        let c = self.coll(database, collection);
        let mut action = c.find(filter).batch_size(page_size.clamp(1, 5000) as u32);
        if !projection.is_empty() {
            action = action.projection(projection);
        }
        if !sort.is_empty() {
            action = action.sort(sort);
        }
        if skip > 0 {
            action = action.skip(skip);
        }
        if limit > 0 {
            action = action.limit(limit as i64);
        }
        if let Some(t) = self.timeout {
            action = action.max_time(t);
        }
        let cursor = self
            .cancellable(async { action.await.map_err(map_err) })
            .await?;
        self.begin(cursor, page_size, sink, started, None).await
    }

    fn checked_filter(id: &Json, check: &[FieldCheck], force: bool) -> DriverResult<Document> {
        let mut filter = doc! {"_id": from_json(id)?};
        if !force {
            for c in check {
                let cond = if c.absent {
                    Bson::Document(doc! {"$exists": false})
                } else {
                    from_json(&c.value)?
                };
                filter.insert(c.path.clone(), cond);
            }
        }
        Ok(filter)
    }

    async fn current(&self, db: &str, coll: &str, id: &Json) -> DriverResult<Option<Json>> {
        let found = self
            .coll(db, coll)
            .find_one(doc! {"_id": from_json(id)?})
            .await
            .map_err(map_err)?;
        Ok(found.map(doc_to_json))
    }

    async fn index_list(&self, db: &str, coll: &str) -> DriverResult<Vec<IndexInfo>> {
        let c = self.coll(db, coll);
        let mut cursor = c.list_indexes().await.map_err(map_err)?;
        // sizes come from collStats; best effort
        let sizes = self
            .client
            .database(db)
            .run_command(doc! {"collStats": coll})
            .await
            .ok()
            .and_then(|d| d.get_document("indexSizes").ok().cloned());
        let mut out = Vec::new();
        while cursor.advance().await.map_err(map_err)? {
            let m = cursor.deserialize_current().map_err(map_err)?;
            let name = m
                .options
                .as_ref()
                .and_then(|o| o.name.clone())
                .unwrap_or_default();
            let o = m.options.unwrap_or_default();
            let size = sizes.as_ref().and_then(|s| match s.get(&name) {
                Some(Bson::Int32(n)) => Some(*n as i64),
                Some(Bson::Int64(n)) => Some(*n),
                _ => None,
            });
            out.push(IndexInfo {
                name,
                keys: doc_to_json(m.keys),
                unique: o.unique.unwrap_or(false),
                sparse: o.sparse.unwrap_or(false),
                ttl_seconds: o.expire_after.map(|d| d.as_secs() as i64),
                size_bytes: size,
            });
        }
        Ok(out)
    }

    async fn explain(
        &self,
        db: &str,
        coll: &str,
        filter: Document,
        sort: Document,
    ) -> DriverResult<DocReply> {
        let mut find = doc! {"find": coll, "filter": filter};
        if !sort.is_empty() {
            find.insert("sort", sort);
        }
        let out = self
            .client
            .database(db)
            .run_command(doc! {"explain": find, "verbosity": "queryPlanner"})
            .await
            .map_err(map_err)?;
        let mut index = None;
        let mut collscan = false;
        if let Ok(qp) = out.get_document("queryPlanner") {
            if let Ok(w) = qp.get_document("winningPlan") {
                walk_plan(w, &mut index, &mut collscan);
            }
        }
        Ok(DocReply::Explain { index, collscan })
    }

    async fn count(
        &self,
        db: &str,
        coll: &str,
        filter: Document,
        cap: u64,
    ) -> DriverResult<DocReply> {
        let c = self.coll(db, coll);
        let mut action = c.count_documents(filter);
        if cap > 0 {
            action = action.limit(cap + 1);
        }
        if let Some(t) = self.timeout {
            action = action.max_time(t);
        }
        let n = self
            .cancellable(async { action.await.map_err(map_err) })
            .await?;
        let capped = cap > 0 && n > cap;
        Ok(DocReply::Count {
            count: if capped { cap } else { n },
            capped,
        })
    }

    #[allow(clippy::too_many_arguments)] // the query bar's fields plus where to write
    async fn export(
        &self,
        db: &str,
        coll: &str,
        filter: Document,
        projection: Document,
        sort: Document,
        format: ExportFormat,
        path: &str,
    ) -> DriverResult<DocReply> {
        use std::io::Write;
        let c = self.coll(db, coll);
        let mut action = c.find(filter);
        if !projection.is_empty() {
            action = action.projection(projection);
        }
        if !sort.is_empty() {
            action = action.sort(sort);
        }
        let mut cursor = action.await.map_err(map_err)?;
        let io = |e: std::io::Error| {
            DriverError::new(ErrorCode::QueryFailed, format!("Writing {path}: {e}"))
        };
        let file = std::fs::File::create(path).map_err(io)?;
        let mut w = std::io::BufWriter::new(file);
        let mut n = 0u64;
        let mut columns: Vec<String> = Vec::new();
        let mut rows: Vec<Document> = Vec::new();
        if format == ExportFormat::Json {
            w.write_all(b"[\n").map_err(io)?;
        }
        while self
            .cancellable(async { cursor.advance().await.map_err(map_err) })
            .await?
        {
            let d = cursor.deserialize_current().map_err(map_err)?;
            match format {
                ExportFormat::Jsonl => {
                    let j = to_json_relaxed(&d);
                    writeln!(w, "{j}").map_err(io)?;
                }
                ExportFormat::Json => {
                    if n > 0 {
                        w.write_all(b",\n").map_err(io)?;
                    }
                    write!(w, "  {}", to_json_relaxed(&d)).map_err(io)?;
                }
                ExportFormat::Csv => {
                    let flat = flatten(&d);
                    for k in flat.keys() {
                        if !columns.contains(k) {
                            columns.push(k.clone());
                        }
                    }
                    rows.push(d);
                }
            }
            n += 1;
        }
        match format {
            ExportFormat::Json => w.write_all(b"\n]\n").map_err(io)?,
            ExportFormat::Csv => {
                writeln!(w, "{}", csv_line(columns.iter().map(String::as_str))).map_err(io)?;
                for d in &rows {
                    let flat = flatten(d);
                    let cells = columns
                        .iter()
                        .map(|c| flat.get(c).map_or("", String::as_str));
                    writeln!(w, "{}", csv_line(cells)).map_err(io)?;
                }
            }
            ExportFormat::Jsonl => {}
        }
        w.flush().map_err(io)?;
        Ok(DocReply::Exported { count: n })
    }

    async fn shell(
        &mut self,
        database: &str,
        text: &str,
        page_size: usize,
        sink: &ResultSink,
    ) -> DriverResult<DocReply> {
        let started = Instant::now();
        let cmd = shell::parse_command(text).map_err(|e| parse_err("Command", e))?;
        match cmd {
            Command::ShowDatabases => {
                let names = self.client.list_database_names().await.map_err(map_err)?;
                let docs = names.into_iter().map(|n| doc! {"name": n}).collect();
                Ok(self.literal(docs, sink, started, None).await)
            }
            Command::ShowCollections => {
                let names = self
                    .client
                    .database(database)
                    .list_collection_names()
                    .await
                    .map_err(map_err)?;
                let docs = names.into_iter().map(|n| doc! {"name": n}).collect();
                Ok(self.literal(docs, sink, started, None).await)
            }
            Command::Use(db) => {
                self.default_db = Some(db.clone());
                Ok(self.literal(vec![doc! {"switched to db": db.clone()}], sink, started, Some(db)).await)
            }
            Command::Database { call } => match call.name.as_str() {
                "getName" => Ok(DocReply::Value { value: json!(database) }),
                "stats" => {
                    let d = self
                        .client
                        .database(database)
                        .run_command(doc! {"dbStats": 1})
                        .await
                        .map_err(map_err)?;
                    Ok(self.literal(vec![d], sink, started, None).await)
                }
                other => Err(DriverError::new(
                    ErrorCode::Unsupported,
                    format!("db.{other}() isn't supported. Only db.<collection>.<method>(…) commands are supported"),
                )),
            },
            Command::Collection { collection, call, chain } => {
                self.run_method(database, &collection, call, chain, page_size, sink, started).await
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_method(
        &mut self,
        db: &str,
        coll: &str,
        call: Call,
        chain: Vec<Call>,
        page_size: usize,
        sink: &ResultSink,
        started: Instant,
    ) -> DriverResult<DocReply> {
        let arg_doc = |i: usize| -> DriverResult<Document> {
            match call.args.get(i) {
                None => Ok(doc! {}),
                Some(Bson::Document(d)) => Ok(d.clone()),
                Some(_) => Err(DriverError::new(
                    ErrorCode::QueryFailed,
                    format!("{}: argument {} must be an object", call.name, i + 1),
                )),
            }
        };
        let c = self.coll(db, coll);
        match call.name.as_str() {
            "find" | "findOne" => {
                let mut projection = arg_doc(1)?;
                let mut sort = doc! {};
                let (mut skip, mut limit) = (0u64, if call.name == "findOne" { 1 } else { 0 });
                for m in &chain {
                    let int = || match m.args.first() {
                        Some(Bson::Int32(n)) => Ok(*n as u64),
                        Some(Bson::Int64(n)) => Ok(*n as u64),
                        Some(Bson::Double(n)) => Ok(*n as u64),
                        _ => Err(DriverError::new(
                            ErrorCode::QueryFailed,
                            format!("{} takes a number", m.name),
                        )),
                    };
                    match m.name.as_str() {
                        "sort" => {
                            sort = match m.args.first() {
                                Some(Bson::Document(d)) => d.clone(),
                                _ => doc! {},
                            }
                        }
                        "project" => {
                            projection = match m.args.first() {
                                Some(Bson::Document(d)) => d.clone(),
                                _ => doc! {},
                            }
                        }
                        "limit" => limit = int()?,
                        "skip" => skip = int()?,
                        _ => {}
                    }
                }
                self.find(
                    db,
                    coll,
                    arg_doc(0)?,
                    projection,
                    sort,
                    skip,
                    limit,
                    page_size,
                    sink,
                )
                .await
            }
            "aggregate" => {
                let stages = match call.args.first() {
                    Some(Bson::Array(a)) => a
                        .iter()
                        .map(|s| match s {
                            Bson::Document(d) => Ok(d.clone()),
                            _ => Err(DriverError::new(
                                ErrorCode::QueryFailed,
                                "Each pipeline stage must be an object",
                            )),
                        })
                        .collect::<DriverResult<Vec<_>>>()?,
                    _ => {
                        return Err(DriverError::new(
                            ErrorCode::QueryFailed,
                            "aggregate takes an array of stages",
                        ))
                    }
                };
                self.aggregate(db, coll, stages, page_size, sink).await
            }
            "countDocuments" => {
                let n = c.count_documents(arg_doc(0)?).await.map_err(map_err)?;
                Ok(DocReply::Value {
                    value: to_json(Bson::Int64(n as i64)),
                })
            }
            "estimatedDocumentCount" => {
                let n = c.estimated_document_count().await.map_err(map_err)?;
                Ok(DocReply::Value {
                    value: to_json(Bson::Int64(n as i64)),
                })
            }
            "distinct" => {
                let Some(Bson::String(field)) = call.args.first() else {
                    return Err(DriverError::new(
                        ErrorCode::QueryFailed,
                        "distinct takes a field name",
                    ));
                };
                let values = c.distinct(field, arg_doc(1)?).await.map_err(map_err)?;
                Ok(DocReply::Value {
                    value: to_json(Bson::Array(values)),
                })
            }
            "getIndexes" => {
                let items = self.index_list(db, coll).await?;
                let docs = items
                    .into_iter()
                    .map(|i| doc! {"name": i.name, "key": doc_from_json(&i.keys).unwrap_or_default(), "unique": i.unique})
                    .collect();
                Ok(self.literal(docs, sink, started, None).await)
            }
            write => {
                self.guard_write()?;
                match write {
                    "insertOne" => {
                        let d = arg_doc(0)?;
                        let r = c.insert_one(d).await.map_err(map_err)?;
                        Ok(DocReply::Value { value: json!({"acknowledged": true, "insertedId": to_json(r.inserted_id)}) })
                    }
                    "insertMany" => {
                        let Some(Bson::Array(a)) = call.args.first() else {
                            return Err(DriverError::new(ErrorCode::QueryFailed, "insertMany takes an array of documents"));
                        };
                        let docs: Vec<Document> = a
                            .iter()
                            .filter_map(|b| if let Bson::Document(d) = b { Some(d.clone()) } else { None })
                            .collect();
                        let r = c.insert_many(docs).await.map_err(map_err)?;
                        let ids: Vec<Json> = r.inserted_ids.into_values().map(to_json).collect();
                        Ok(DocReply::Value { value: json!({"acknowledged": true, "insertedIds": ids}) })
                    }
                    "updateOne" | "updateMany" | "replaceOne" => {
                        let filter = arg_doc(0)?;
                        let upsert = matches!(call.args.get(2), Some(Bson::Document(o)) if o.get_bool("upsert").unwrap_or(false));
                        let r = match write {
                            "updateOne" => c.update_one(filter, arg_doc(1)?).upsert(upsert).await,
                            "updateMany" => c.update_many(filter, arg_doc(1)?).upsert(upsert).await,
                            _ => c.replace_one(filter, arg_doc(1)?).upsert(upsert).await,
                        }
                        .map_err(map_err)?;
                        Ok(DocReply::Value {
                            value: json!({"acknowledged": true, "matchedCount": r.matched_count, "modifiedCount": r.modified_count,
                                          "upsertedId": r.upserted_id.map(to_json)}),
                        })
                    }
                    "deleteOne" => {
                        let r = c.delete_one(arg_doc(0)?).await.map_err(map_err)?;
                        Ok(DocReply::Value { value: json!({"acknowledged": true, "deletedCount": r.deleted_count}) })
                    }
                    "deleteMany" => {
                        let r = c.delete_many(arg_doc(0)?).await.map_err(map_err)?;
                        Ok(DocReply::Value { value: json!({"acknowledged": true, "deletedCount": r.deleted_count}) })
                    }
                    "createIndex" => {
                        let keys = arg_doc(0)?;
                        let o = arg_doc(1)?;
                        let model = IndexModel::builder()
                            .keys(keys)
                            .options(
                                IndexOptions::builder()
                                    .unique(o.get_bool("unique").ok())
                                    .sparse(o.get_bool("sparse").ok())
                                    .name(o.get_str("name").ok().map(str::to_string))
                                    .build(),
                            )
                            .build();
                        let r = c.create_index(model).await.map_err(map_err)?;
                        Ok(DocReply::Value { value: json!(r.index_name) })
                    }
                    "dropIndex" => {
                        let Some(Bson::String(name)) = call.args.first() else {
                            return Err(DriverError::new(ErrorCode::QueryFailed, "dropIndex takes an index name"));
                        };
                        c.drop_index(name.clone()).await.map_err(map_err)?;
                        Ok(DocReply::Value { value: json!({"ok": 1}) })
                    }
                    "drop" => {
                        c.drop().await.map_err(map_err)?;
                        Ok(DocReply::Value { value: json!(true) })
                    }
                    other => Err(DriverError::new(
                        ErrorCode::Unsupported,
                        format!("{other}() isn't supported. Only db.<collection>.<method>(…) commands are supported"),
                    )),
                }
            }
        }
    }

    async fn aggregate(
        &mut self,
        db: &str,
        coll: &str,
        stages: Vec<Document>,
        page_size: usize,
        sink: &ResultSink,
    ) -> DriverResult<DocReply> {
        if stages
            .iter()
            .any(|s| s.contains_key("$out") || s.contains_key("$merge"))
        {
            self.guard_write()?;
        }
        let started = Instant::now();
        let c = self.coll(db, coll);
        let mut action = c
            .aggregate(stages)
            .batch_size(page_size.clamp(1, 5000) as u32);
        if let Some(t) = self.timeout {
            action = action.max_time(t);
        }
        let raw = self
            .cancellable(async { action.await.map_err(map_err) })
            .await?;
        let cursor = raw.with_type::<Document>();
        self.begin(cursor, page_size, sink, started, None).await
    }
}

fn walk_plan(stage: &Document, index: &mut Option<String>, collscan: &mut bool) {
    match stage.get_str("stage") {
        Ok("COLLSCAN") => *collscan = true,
        Ok("IXSCAN" | "EXPRESS_IXSCAN" | "EXPRESS_CLUSTERED_IXSCAN") if index.is_none() => {
            *index = stage.get_str("indexName").ok().map(str::to_string);
        }
        _ => {}
    }
    if let Ok(child) = stage.get_document("inputStage") {
        walk_plan(child, index, collscan);
    }
    if let Ok(children) = stage.get_array("inputStages") {
        for c in children {
            if let Bson::Document(d) = c {
                walk_plan(d, index, collscan);
            }
        }
    }
    if let Ok(shards) = stage.get_array("shards") {
        for s in shards {
            if let Bson::Document(d) = s {
                if let Ok(w) = d.get_document("winningPlan") {
                    walk_plan(w, index, collscan);
                }
            }
        }
    }
}

fn csv_line<'a>(cells: impl Iterator<Item = &'a str>) -> String {
    cells
        .map(|c| {
            if c.contains([',', '"', '\n', '\r']) {
                format!("\"{}\"", c.replace('"', "\"\""))
            } else {
                c.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Relaxed Extended JSON for files people will read.
fn to_json_relaxed(d: &Document) -> String {
    Bson::Document(d.clone()).into_relaxed_extjson().to_string()
}

/// Flatten a document to dotted-path → text, for CSV.
fn flatten(d: &Document) -> std::collections::BTreeMap<String, String> {
    fn go(prefix: &str, b: &Bson, out: &mut std::collections::BTreeMap<String, String>) {
        match b {
            Bson::Document(d) => {
                for (k, v) in d {
                    let p = if prefix.is_empty() {
                        k.clone()
                    } else {
                        format!("{prefix}.{k}")
                    };
                    go(&p, v, out);
                }
            }
            Bson::String(s) => {
                out.insert(prefix.to_string(), s.clone());
            }
            Bson::Null => {
                out.insert(prefix.to_string(), String::new());
            }
            Bson::ObjectId(o) => {
                out.insert(prefix.to_string(), o.to_hex());
            }
            Bson::Int32(n) => {
                out.insert(prefix.to_string(), n.to_string());
            }
            Bson::Int64(n) => {
                out.insert(prefix.to_string(), n.to_string());
            }
            Bson::Double(n) => {
                out.insert(prefix.to_string(), n.to_string());
            }
            Bson::Boolean(n) => {
                out.insert(prefix.to_string(), n.to_string());
            }
            Bson::DateTime(t) => {
                out.insert(
                    prefix.to_string(),
                    t.try_to_rfc3339_string().unwrap_or_default(),
                );
            }
            other => {
                out.insert(
                    prefix.to_string(),
                    other.clone().into_relaxed_extjson().to_string(),
                );
            }
        }
    }
    let mut out = std::collections::BTreeMap::new();
    go("", &Bson::Document(d.clone()), &mut out);
    out
}

#[async_trait]
impl DocumentSession for MongoSession {
    async fn call(&mut self, request: DocRequest, sink: ResultSink) -> DriverResult<DocReply> {
        let p =
            |field: &str, text: &str| shell::parse_document(text).map_err(|e| parse_err(field, e));
        match request {
            DocRequest::Databases => {
                let mut names = self.client.list_database_names().await.map_err(map_err)?;
                names.sort();
                Ok(DocReply::Databases { names })
            }
            DocRequest::Collections { database } => {
                let items = self
                    .client
                    .database(&database)
                    .list_collection_names()
                    .await
                    .map_err(map_err)?
                    .into_iter()
                    .map(|name| crate::drivers::nosql::CollectionInfo {
                        name,
                        count: None,
                        kind: "collection".into(),
                    })
                    .collect();
                Ok(DocReply::Collections { items })
            }
            DocRequest::Evaluate { text } => {
                let value = shell::parse_value(&text).map_err(|e| parse_err("Document", e))?;
                Ok(DocReply::Value {
                    value: value.map_or(Json::Null, to_json),
                })
            }
            DocRequest::Parse { field, text } => {
                if field == "pipeline" {
                    shell::parse_pipeline(&text).map_err(|e| parse_err(&field, e))?;
                } else {
                    p(&field, &text)?;
                }
                Ok(DocReply::Parsed)
            }
            DocRequest::Find {
                database,
                collection,
                filter,
                projection,
                sort,
                skip,
                limit,
                page_size,
            } => {
                let (f, pr, s) = (
                    p("Filter", &filter)?,
                    p("Project", &projection)?,
                    p("Sort", &sort)?,
                );
                self.find(
                    &database,
                    &collection,
                    f,
                    pr,
                    s,
                    skip,
                    limit,
                    page_size,
                    &sink,
                )
                .await
            }
            DocRequest::Aggregate {
                database,
                collection,
                pipeline,
                page_size,
            } => {
                let stages =
                    shell::parse_pipeline(&pipeline).map_err(|e| parse_err("Pipeline", e))?;
                self.aggregate(&database, &collection, stages, page_size, &sink)
                    .await
            }
            DocRequest::Explain {
                database,
                collection,
                filter,
                sort,
            } => {
                self.explain(
                    &database,
                    &collection,
                    p("Filter", &filter)?,
                    p("Sort", &sort)?,
                )
                .await
            }
            DocRequest::Count {
                database,
                collection,
                filter,
                cap,
            } => {
                self.count(&database, &collection, p("Filter", &filter)?, cap)
                    .await
            }
            DocRequest::Insert {
                database,
                collection,
                documents,
            } => {
                self.guard_write()?;
                let docs = documents
                    .iter()
                    .map(doc_from_json)
                    .collect::<DriverResult<Vec<_>>>()?;
                let r = self
                    .coll(&database, &collection)
                    .insert_many(docs)
                    .await
                    .map_err(map_err)?;
                let mut ids: Vec<(usize, Bson)> = r.inserted_ids.into_iter().collect();
                ids.sort_by_key(|(i, _)| *i);
                Ok(DocReply::Written {
                    inserted: ids.into_iter().map(|(_, b)| to_json(b)).collect(),
                    matched: 0,
                    modified: 0,
                    deleted: 0,
                })
            }
            DocRequest::Replace {
                database,
                collection,
                id,
                document,
                check,
                force,
            } => {
                self.guard_write()?;
                let filter = Self::checked_filter(&id, &check, force)?;
                let r = self
                    .coll(&database, &collection)
                    .replace_one(filter, doc_from_json(&document)?)
                    .await
                    .map_err(map_err)?;
                if r.matched_count == 0 {
                    return Ok(DocReply::Conflict {
                        current: self.current(&database, &collection, &id).await?,
                    });
                }
                Ok(DocReply::Written {
                    inserted: vec![],
                    matched: r.matched_count,
                    modified: r.modified_count,
                    deleted: 0,
                })
            }
            DocRequest::Update {
                database,
                collection,
                id,
                set,
                unset,
                check,
                force,
            } => {
                self.guard_write()?;
                let filter = Self::checked_filter(&id, &check, force)?;
                let mut update = doc! {};
                let set = doc_from_json(&set)?;
                if !set.is_empty() {
                    update.insert("$set", set);
                }
                if !unset.is_empty() {
                    update.insert(
                        "$unset",
                        unset
                            .into_iter()
                            .map(|u| (u, Bson::String(String::new())))
                            .collect::<Document>(),
                    );
                }
                if update.is_empty() {
                    return Ok(DocReply::Written {
                        inserted: vec![],
                        matched: 1,
                        modified: 0,
                        deleted: 0,
                    });
                }
                let r = self
                    .coll(&database, &collection)
                    .update_one(filter, update)
                    .await
                    .map_err(map_err)?;
                if r.matched_count == 0 {
                    return Ok(DocReply::Conflict {
                        current: self.current(&database, &collection, &id).await?,
                    });
                }
                Ok(DocReply::Written {
                    inserted: vec![],
                    matched: r.matched_count,
                    modified: r.modified_count,
                    deleted: 0,
                })
            }
            DocRequest::Delete {
                database,
                collection,
                ids,
            } => {
                self.guard_write()?;
                let ids = ids
                    .iter()
                    .map(from_json)
                    .collect::<DriverResult<Vec<_>>>()?;
                let r = self
                    .coll(&database, &collection)
                    .delete_many(doc! {"_id": {"$in": ids}})
                    .await
                    .map_err(map_err)?;
                Ok(DocReply::Written {
                    inserted: vec![],
                    matched: 0,
                    modified: 0,
                    deleted: r.deleted_count,
                })
            }
            DocRequest::Indexes {
                database,
                collection,
            } => Ok(DocReply::Indexes {
                items: self.index_list(&database, &collection).await?,
            }),
            DocRequest::CreateIndex {
                database,
                collection,
                keys,
                name,
                unique,
                sparse,
                ttl_seconds,
            } => {
                self.guard_write()?;
                let keys = p("Keys", &keys)?;
                if keys.is_empty() {
                    return Err(DriverError::new(
                        ErrorCode::QueryFailed,
                        "An index needs at least one key",
                    ));
                }
                let model = IndexModel::builder()
                    .keys(keys)
                    .options(
                        IndexOptions::builder()
                            .name(name)
                            .unique(unique.then_some(true))
                            .sparse(sparse.then_some(true))
                            .expire_after(ttl_seconds.map(|s| Duration::from_secs(s.max(0) as u64)))
                            .build(),
                    )
                    .build();
                self.coll(&database, &collection)
                    .create_index(model)
                    .await
                    .map_err(map_err)?;
                Ok(DocReply::Indexes {
                    items: self.index_list(&database, &collection).await?,
                })
            }
            DocRequest::DropIndex {
                database,
                collection,
                name,
            } => {
                self.guard_write()?;
                self.coll(&database, &collection)
                    .drop_index(name)
                    .await
                    .map_err(map_err)?;
                Ok(DocReply::Indexes {
                    items: self.index_list(&database, &collection).await?,
                })
            }
            DocRequest::Schema {
                database,
                collection,
                filter,
                sample,
            } => {
                let mut stages = vec![];
                let f = p("Filter", &filter)?;
                if !f.is_empty() {
                    stages.push(doc! {"$match": f});
                }
                stages.push(doc! {"$sample": {"size": sample.max(1) as i64}});
                let mut cursor = self
                    .coll(&database, &collection)
                    .aggregate(stages)
                    .await
                    .map_err(map_err)?
                    .with_type::<Document>();
                let mut docs = Vec::new();
                while cursor.advance().await.map_err(map_err)? {
                    docs.push(cursor.deserialize_current().map_err(map_err)?);
                }
                Ok(DocReply::Schema {
                    sampled: docs.len() as u64,
                    fields: schema::infer(&docs),
                })
            }
            DocRequest::Shell {
                database,
                text,
                page_size,
            } => {
                let db = if database.is_empty() {
                    self.default_db.clone().unwrap_or_else(|| "test".into())
                } else {
                    database
                };
                self.shell(&db, &text, page_size, &sink).await
            }
            DocRequest::Export {
                database,
                collection,
                filter,
                projection,
                sort,
                format,
                path,
            } => {
                let (f, pr, s) = (
                    p("Filter", &filter)?,
                    p("Project", &projection)?,
                    p("Sort", &sort)?,
                );
                self.export(&database, &collection, f, pr, s, format, &path)
                    .await
            }
        }
    }
}

#[async_trait]
impl Session for MongoSession {
    /// The console: one shell command. Documents stream as `Documents` events for the tree and
    /// JSON views, and as `Columns` / `Rows` so the grid, copy and export work on them too.
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = Instant::now();
        let db = self.default_db.clone().unwrap_or_else(|| "test".into());
        self.tabular_mode = true;
        let reply = self.shell(&db, &req.sql, req.page_size, &sink).await;
        self.tabular_mode = false;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let done = |result_id: ResultId, has_more: bool| {
            (
                ExecSummary {
                    rows_affected: None,
                    elapsed_ms,
                    has_more,
                },
                result_id,
            )
        };
        match reply? {
            DocReply::Found {
                result_id,
                has_more,
                ..
            } => {
                let (summary, id) = done(result_id, has_more);
                sink.send(ResultEvent::Done {
                    result_id: id,
                    summary: summary.clone(),
                })
                .await;
                Ok(summary)
            }
            // a count, an insert acknowledgement…: one document with the answer
            DocReply::Value { value } => {
                let doc = match from_json(&value)? {
                    Bson::Document(d) => d,
                    other => doc! {"result": other},
                };
                let id = self.next_result;
                self.next_result += 1;
                self.tabular_mode = true;
                self.emit_docs(&sink, id, vec![doc]).await;
                self.tabular_mode = false;
                let (summary, id) = done(id, false);
                sink.send(ResultEvent::Done {
                    result_id: id,
                    summary: summary.clone(),
                })
                .await;
                Ok(summary)
            }
            _ => Ok(ExecSummary {
                rows_affected: None,
                elapsed_ms,
                has_more: false,
            }),
        }
    }

    async fn set_read_only(&mut self, read_only: bool) -> DriverResult<()> {
        self.read_only = read_only;
        Ok(())
    }

    async fn fetch_more(
        &mut self,
        result_id: ResultId,
        n: usize,
        sink: ResultSink,
    ) -> DriverResult<bool> {
        let removed = self.cursors.get_mut().unwrap().remove(&result_id);
        let Some(mut open) = removed else {
            return Ok(false);
        };
        let (docs, more) = Self::page(&mut open, n.max(1)).await?;
        if more {
            self.cursors.get_mut().unwrap().insert(result_id, open);
        }
        self.emit_docs(&sink, result_id, docs).await;
        if self.tabular.contains_key(&result_id) {
            sink.send(ResultEvent::Done {
                result_id,
                summary: ExecSummary {
                    rows_affected: None,
                    elapsed_ms: 0,
                    has_more: more,
                },
            })
            .await;
        }
        Ok(more)
    }

    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::new(Canceller(self.cancel.clone()))
    }

    fn server_info(&self) -> ServerInfo {
        self.info.clone()
    }

    fn as_documents(&mut self) -> Option<&mut dyn DocumentSession> {
        Some(self)
    }

    async fn close(self: Box<Self>) -> DriverResult<()> {
        Ok(())
    }
}

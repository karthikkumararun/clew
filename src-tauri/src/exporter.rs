//! Streaming export of a query result (or rows the grid already holds) to CSV, TSV, JSON,
//! JSON lines, Markdown or SQL `INSERT` statements. Rows go from the driver to the file one page
//! at a time, so memory stays bounded however large the table is.

use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, NaiveDateTime};
use serde::{Deserialize, Serialize};

use crate::drivers::ResultEvent;
use crate::drivers::{ColumnMeta, Value};
use crate::error::{AppError, AppResult};
use crate::sessions::SessionManager;

/// Rows fetched from the server per round trip while exporting.
pub const PAGE_ROWS: usize = 5000;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileFormat {
    Csv,
    Tsv,
    /// One JSON array of objects.
    Json,
    /// One JSON object per line.
    Jsonl,
    Markdown,
    Insert,
}

impl FileFormat {
    pub fn extension(self) -> &'static str {
        match self {
            FileFormat::Csv => "csv",
            FileFormat::Tsv => "tsv",
            FileFormat::Json => "json",
            FileFormat::Jsonl => "jsonl",
            FileFormat::Markdown => "md",
            FileFormat::Insert => "sql",
        }
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExportDateFormat {
    /// As the driver reports it (ISO 8601).
    #[default]
    Iso,
    /// `2026-10-08 21:14:07`: no `T`, fraction or zone.
    Plain,
    /// Seconds since 1970-01-01 UTC.
    Epoch,
}

/// How SQL literals are written for `INSERT` output.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SqlFlavor {
    Postgres,
    Mysql,
    Sqlite,
    Sqlserver,
    Oracle,
    #[default]
    Standard,
}

impl SqlFlavor {
    pub fn of_driver(id: &str) -> Self {
        match id {
            "postgres" | "duckdb" => SqlFlavor::Postgres,
            "mysql" | "mariadb" | "clickhouse" => SqlFlavor::Mysql,
            "sqlite" => SqlFlavor::Sqlite,
            "sqlserver" => SqlFlavor::Sqlserver,
            "oracle" => SqlFlavor::Oracle,
            _ => SqlFlavor::Standard,
        }
    }

    pub fn quote_ident(self, name: &str) -> String {
        match self {
            SqlFlavor::Mysql => format!("`{}`", name.replace('`', "``")),
            SqlFlavor::Sqlserver => format!("[{}]", name.replace(']', "]]")),
            _ => format!("\"{}\"", name.replace('"', "\"\"")),
        }
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileExportOptions {
    /// Write a header row (CSV / TSV).
    #[serde(default = "yes")]
    pub header: bool,
    /// Field delimiter for CSV (default `,`); TSV always uses a tab.
    #[serde(default)]
    pub delimiter: Option<String>,
    /// What NULL becomes in CSV / TSV / Markdown.
    #[serde(default)]
    pub null_text: String,
    #[serde(default)]
    pub date_format: ExportDateFormat,
    /// Already-quoted table name for `INSERT` output.
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub flavor: SqlFlavor,
}

fn yes() -> bool {
    true
}

impl Default for FileExportOptions {
    fn default() -> Self {
        Self {
            header: true,
            delimiter: None,
            null_text: String::new(),
            date_format: ExportDateFormat::Iso,
            table: None,
            flavor: SqlFlavor::Standard,
        }
    }
}

// ---- value formatting ----------------------------------------------------------------------

fn plain_timestamp(s: &str) -> String {
    let no_zone = s
        .split_once('+')
        .map(|(a, _)| a)
        .unwrap_or(s)
        .trim_end_matches('Z');
    // A trailing `-hh:mm` offset (but not the dashes of the date).
    let no_zone = match no_zone.rfind('-') {
        Some(i) if i > 10 => &no_zone[..i],
        _ => no_zone,
    };
    let base = no_zone.split('.').next().unwrap_or(no_zone);
    base.replacen('T', " ", 1)
}

fn epoch_seconds(v: &Value) -> Option<i64> {
    match v {
        Value::Timestamptz { value } => DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|d| d.timestamp()),
        Value::Timestamp { value } => NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
            .ok()
            .map(|d| d.and_utc().timestamp()),
        _ => None,
    }
}

/// A cell as text; `None` for NULL.
pub fn cell_text(v: &Value, date_format: ExportDateFormat) -> Option<String> {
    match v {
        Value::Null => None,
        Value::Bytes { value, .. } => Some(format!("\\x{value}")),
        Value::Array { value } => Some(format!(
            "{{{}}}",
            value
                .iter()
                .map(|x| cell_text(x, date_format).unwrap_or_else(|| "NULL".into()))
                .collect::<Vec<_>>()
                .join(",")
        )),
        Value::Timestamp { value } | Value::Timestamptz { value } => Some(match date_format {
            ExportDateFormat::Iso => value.clone(),
            ExportDateFormat::Plain => plain_timestamp(value),
            ExportDateFormat::Epoch => {
                epoch_seconds(v).map_or_else(|| value.clone(), |s| s.to_string())
            }
        }),
        other => other.sql_text(),
    }
}

fn json_of(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Null => J::Null,
        Value::Bool { value } => J::Bool(*value),
        Value::Int { value } => J::from(*value),
        Value::Float { value } => serde_json::Number::from_f64(*value)
            .map_or_else(|| J::String(value.to_string()), J::Number),
        Value::Json { value } => value.clone(),
        Value::Array { value } => J::Array(value.iter().map(json_of).collect()),
        other => J::String(cell_text(other, ExportDateFormat::Iso).unwrap_or_default()),
    }
}

fn quote_text(flavor: SqlFlavor, s: &str) -> String {
    let escaped = if flavor == SqlFlavor::Mysql {
        s.replace('\\', "\\\\")
    } else {
        s.to_string()
    };
    format!("'{}'", escaped.replace('\'', "''"))
}

/// A value as a SQL literal for the dialect.
pub fn sql_literal(flavor: SqlFlavor, v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool { value } => match (flavor, *value) {
            (SqlFlavor::Sqlite | SqlFlavor::Sqlserver | SqlFlavor::Oracle, true) => "1".into(),
            (SqlFlavor::Sqlite | SqlFlavor::Sqlserver | SqlFlavor::Oracle, false) => "0".into(),
            (_, true) => "TRUE".into(),
            (_, false) => "FALSE".into(),
        },
        Value::Int { value } => value.to_string(),
        Value::Float { value } if value.is_finite() => value.to_string(),
        Value::Float { .. } => "NULL".into(),
        Value::Bigint { value } | Value::Decimal { value }
            if value.parse::<f64>().is_ok_and(f64::is_finite)
                && !value.contains(char::is_alphabetic) =>
        {
            value.clone()
        }
        Value::Bytes { value, .. } => match flavor {
            SqlFlavor::Postgres => format!("'\\x{value}'"),
            SqlFlavor::Sqlserver => format!("0x{value}"),
            _ => format!("X'{value}'"),
        },
        Value::Json { value } => quote_text(flavor, &value.to_string()),
        other => quote_text(
            flavor,
            &cell_text(other, ExportDateFormat::Iso).unwrap_or_default(),
        ),
    }
}

// ---- row writers ----------------------------------------------------------------------------

/// Receives a result a row at a time.
pub trait RowSink: Send {
    fn start(&mut self, columns: &[ColumnMeta]) -> io::Result<()>;
    fn row(&mut self, row: &[Value]) -> io::Result<()>;
    fn finish(&mut self) -> io::Result<()>;
}

struct Delimited<W: Write + Send> {
    out: W,
    delimiter: String,
    quote: bool,
    options: FileExportOptions,
}

impl<W: Write + Send> Delimited<W> {
    fn field(&self, text: &str) -> String {
        if self.quote && (text.contains(&self.delimiter) || text.contains(['"', '\r', '\n'])) {
            format!("\"{}\"", text.replace('"', "\"\""))
        } else if !self.quote {
            // TSV has no quoting: keep a field on its line.
            text.replace(['\t', '\r', '\n'], " ")
        } else {
            text.to_string()
        }
    }

    fn line(&mut self, fields: Vec<String>) -> io::Result<()> {
        let eol = if self.quote { "\r\n" } else { "\n" };
        write!(self.out, "{}{eol}", fields.join(&self.delimiter))
    }
}

impl<W: Write + Send> RowSink for Delimited<W> {
    fn start(&mut self, columns: &[ColumnMeta]) -> io::Result<()> {
        if self.options.header {
            let names = columns.iter().map(|c| self.field(&c.name)).collect();
            self.line(names)?;
        }
        Ok(())
    }
    fn row(&mut self, row: &[Value]) -> io::Result<()> {
        let fields = row
            .iter()
            .map(|v| {
                let text = cell_text(v, self.options.date_format)
                    .unwrap_or_else(|| self.options.null_text.clone());
                self.field(&text)
            })
            .collect();
        self.line(fields)
    }
    fn finish(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}

struct JsonRows<W: Write + Send> {
    out: W,
    names: Vec<String>,
    lines: bool,
    first: bool,
}

impl<W: Write + Send> JsonRows<W> {
    fn object(&self, row: &[Value]) -> String {
        let fields: Vec<String> = self
            .names
            .iter()
            .zip(row)
            .map(|(n, v)| {
                format!(
                    "{}:{}",
                    serde_json::to_string(n).unwrap_or_default(),
                    json_of(v)
                )
            })
            .collect();
        format!("{{{}}}", fields.join(","))
    }
}

impl<W: Write + Send> RowSink for JsonRows<W> {
    fn start(&mut self, columns: &[ColumnMeta]) -> io::Result<()> {
        self.names = columns.iter().map(|c| c.name.clone()).collect();
        if !self.lines {
            self.out.write_all(b"[")?;
        }
        Ok(())
    }
    fn row(&mut self, row: &[Value]) -> io::Result<()> {
        let obj = self.object(row);
        if self.lines {
            writeln!(self.out, "{obj}")
        } else {
            let sep = if self.first { "\n  " } else { ",\n  " };
            self.first = false;
            write!(self.out, "{sep}{obj}")
        }
    }
    fn finish(&mut self) -> io::Result<()> {
        if !self.lines {
            self.out
                .write_all(if self.first { b"]\n" } else { b"\n]\n" })?;
        }
        self.out.flush()
    }
}

struct Markdown<W: Write + Send> {
    out: W,
    null_text: String,
    date_format: ExportDateFormat,
}

impl<W: Write + Send> Markdown<W> {
    fn cell(s: &str) -> String {
        s.replace('\\', "\\\\")
            .replace('|', "\\|")
            .replace(['\r', '\n'], " ")
    }
}

impl<W: Write + Send> RowSink for Markdown<W> {
    fn start(&mut self, columns: &[ColumnMeta]) -> io::Result<()> {
        let head: Vec<_> = columns.iter().map(|c| Self::cell(&c.name)).collect();
        writeln!(self.out, "| {} |", head.join(" | "))?;
        writeln!(
            self.out,
            "| {} |",
            columns
                .iter()
                .map(|_| "---")
                .collect::<Vec<_>>()
                .join(" | ")
        )
    }
    fn row(&mut self, row: &[Value]) -> io::Result<()> {
        let cells: Vec<_> = row
            .iter()
            .map(|v| {
                Self::cell(&cell_text(v, self.date_format).unwrap_or_else(|| {
                    if self.null_text.is_empty() {
                        "NULL".into()
                    } else {
                        self.null_text.clone()
                    }
                }))
            })
            .collect();
        writeln!(self.out, "| {} |", cells.join(" | "))
    }
    fn finish(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}

struct Inserts<W: Write + Send> {
    out: W,
    flavor: SqlFlavor,
    table: String,
    columns: String,
}

impl<W: Write + Send> RowSink for Inserts<W> {
    fn start(&mut self, columns: &[ColumnMeta]) -> io::Result<()> {
        self.columns = columns
            .iter()
            .map(|c| self.flavor.quote_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        Ok(())
    }
    fn row(&mut self, row: &[Value]) -> io::Result<()> {
        let values: Vec<_> = row.iter().map(|v| sql_literal(self.flavor, v)).collect();
        writeln!(
            self.out,
            "INSERT INTO {} ({}) VALUES ({});",
            self.table,
            self.columns,
            values.join(", ")
        )
    }
    fn finish(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}

/// A writer for the format, over any byte sink.
pub fn row_sink<W: Write + Send + 'static>(
    format: FileFormat,
    options: &FileExportOptions,
    out: W,
) -> Box<dyn RowSink> {
    match format {
        FileFormat::Csv => Box::new(Delimited {
            out,
            delimiter: options
                .delimiter
                .clone()
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| ",".into()),
            quote: true,
            options: options.clone(),
        }),
        FileFormat::Tsv => Box::new(Delimited {
            out,
            delimiter: "\t".into(),
            quote: false,
            options: options.clone(),
        }),
        FileFormat::Json => Box::new(JsonRows {
            out,
            names: vec![],
            lines: false,
            first: true,
        }),
        FileFormat::Jsonl => Box::new(JsonRows {
            out,
            names: vec![],
            lines: true,
            first: true,
        }),
        FileFormat::Markdown => Box::new(Markdown {
            out,
            null_text: options.null_text.clone(),
            date_format: options.date_format,
        }),
        FileFormat::Insert => Box::new(Inserts {
            out,
            flavor: options.flavor,
            table: options
                .table
                .clone()
                .unwrap_or_else(|| options.flavor.quote_ident("table_name")),
            columns: String::new(),
        }),
    }
}

// ---- running an export -----------------------------------------------------------------------

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileExportSummary {
    #[ts(type = "number")]
    pub rows: u64,
    #[ts(type = "number")]
    pub bytes: u64,
    pub path: String,
    /// The user cancelled; the partial file was deleted.
    pub cancelled: bool,
}

/// Counts the bytes written so progress can show file size.
struct Counting<W: Write> {
    inner: W,
    bytes: Arc<AtomicU64>,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.bytes.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn io_err(what: &str, e: io::Error) -> AppError {
    AppError::new("io", what.to_string()).with_detail(e.to_string())
}

/// Write rows the caller already holds (the "loaded rows" scope).
pub fn export_rows(
    path: &Path,
    format: FileFormat,
    options: &FileExportOptions,
    columns: &[ColumnMeta],
    rows: &[Vec<Value>],
) -> AppResult<FileExportSummary> {
    let file = std::fs::File::create(path).map_err(|e| io_err("Couldn't create the file", e))?;
    let bytes = Arc::new(AtomicU64::new(0));
    let out = Counting {
        inner: BufWriter::new(file),
        bytes: bytes.clone(),
    };
    let mut sink = row_sink(format, options, out);
    let result = (|| {
        sink.start(columns)?;
        for r in rows {
            sink.row(r)?;
        }
        sink.finish()
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(path);
        return Err(io_err("Couldn't write the file", e));
    }
    Ok(FileExportSummary {
        rows: rows.len() as u64,
        bytes: bytes.load(Ordering::Relaxed),
        path: path.to_string_lossy().into_owned(),
        cancelled: false,
    })
}

struct Shared {
    sink: Box<dyn RowSink>,
    started: bool,
    rows: u64,
    result_id: Option<u64>,
    has_more: bool,
    failure: Option<AppError>,
    columns: Vec<ColumnMeta>,
}

/// What to export from a query and where to put it.
pub struct QueryExport {
    pub connection_id: String,
    pub sql: String,
    pub format: FileFormat,
    pub options: FileExportOptions,
    pub path: PathBuf,
    /// Set to stop the export; the partial file is deleted.
    pub cancel: Arc<AtomicBool>,
    /// Called with (rows, bytes) as pages arrive.
    pub progress: Arc<dyn Fn(u64, u64) + Send + Sync>,
}

/// Re-run the query on a dedicated session and stream its rows into the file.
pub async fn export_query(
    sessions: &Arc<SessionManager>,
    job: QueryExport,
) -> AppResult<FileExportSummary> {
    let QueryExport {
        connection_id,
        sql,
        format,
        options,
        path,
        cancel,
        progress,
    } = job;
    let path = path.as_path();
    let connection_id = connection_id.as_str();
    let options = &options;
    let file = std::fs::File::create(path).map_err(|e| io_err("Couldn't create the file", e))?;
    let bytes = Arc::new(AtomicU64::new(0));
    let out = Counting {
        inner: BufWriter::new(file),
        bytes: bytes.clone(),
    };
    let shared = Arc::new(Mutex::new(Shared {
        sink: row_sink(format, options, out),
        started: false,
        rows: 0,
        result_id: None,
        has_more: false,
        failure: None,
        columns: vec![],
    }));

    let emit: crate::sessions::Emit = {
        let shared = shared.clone();
        let cancel = cancel.clone();
        let bytes = bytes.clone();
        Arc::new(move |event: ResultEvent| {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            let mut s = shared.lock().unwrap();
            if s.failure.is_some() {
                return false;
            }
            match event {
                ResultEvent::Columns {
                    result_id, columns, ..
                } => {
                    s.result_id = Some(result_id);
                    s.columns = columns.clone();
                    match s.sink.start(&columns) {
                        Ok(()) => s.started = true,
                        Err(e) => {
                            s.failure = Some(io_err("Couldn't write the file", e));
                            return false;
                        }
                    }
                }
                ResultEvent::Rows { rows, .. } => {
                    for r in &rows {
                        if let Err(e) = s.sink.row(r) {
                            s.failure = Some(io_err("Couldn't write the file", e));
                            return false;
                        }
                    }
                    s.rows += rows.len() as u64;
                    progress(s.rows, bytes.load(Ordering::Relaxed));
                }
                ResultEvent::Done { summary, .. } => s.has_more = summary.has_more,
                _ => {}
            }
            true
        })
    };

    let opened = sessions
        .open_session(connection_id)
        .await
        .map_err(|e| AppError::new("export", e.message.clone()))?;
    let session = opened.session_id;

    // A cancel request must also reach the server, not just stop our writing.
    let watcher = {
        let sessions = sessions.clone();
        let session = session.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            while !cancel.load(Ordering::Relaxed) {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            let _ = sessions.cancel(&session).await;
        })
    };

    let request = crate::drivers::ExecRequest {
        sql: sql.clone(),
        page_size: PAGE_ROWS,
        script: false,
        continue_on_error: false,
    };
    let mut run = sessions
        .execute_unrecorded(&session, request, emit.clone())
        .await
        .map(|_| ());
    while run.is_ok() && !cancel.load(Ordering::Relaxed) {
        let (more, id) = {
            let s = shared.lock().unwrap();
            (s.has_more && s.failure.is_none(), s.result_id)
        };
        let Some(id) = id.filter(|_| more) else { break };
        run = sessions
            .fetch_more(&session, id, PAGE_ROWS, emit.clone())
            .await
            .map(|_| ());
    }
    watcher.abort();
    let _ = sessions.close_session(&session).await;

    let cancelled = cancel.load(Ordering::Relaxed);
    let (rows, failure, started) = {
        let mut s = shared.lock().unwrap();
        let fin = if cancelled || s.failure.is_some() || run.is_err() {
            Ok(())
        } else {
            s.sink.finish()
        };
        let failure = s
            .failure
            .take()
            .or_else(|| fin.err().map(|e| io_err("Couldn't write the file", e)));
        (s.rows, failure, s.started)
    };
    let remove = |p: &PathBuf| {
        let _ = std::fs::remove_file(p);
    };
    let path_buf = path.to_path_buf();
    if cancelled {
        drop(shared);
        remove(&path_buf);
        return Ok(FileExportSummary {
            rows,
            bytes: 0,
            path: path.to_string_lossy().into_owned(),
            cancelled: true,
        });
    }
    if let Some(e) = failure {
        drop(shared);
        remove(&path_buf);
        return Err(e);
    }
    if let Err(e) = run {
        drop(shared);
        remove(&path_buf);
        return Err(AppError::new("export", e.message.clone()).with_detail(format!("{:?}", e.code)));
    }
    if !started {
        drop(shared);
        remove(&path_buf);
        return Err(AppError::new(
            "export",
            "The statement didn't return any rows to export",
        ));
    }
    Ok(FileExportSummary {
        rows,
        bytes: bytes.load(Ordering::Relaxed),
        path: path.to_string_lossy().into_owned(),
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::ValueKind;

    fn col(name: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            type_name: String::new(),
            kind: ValueKind::Text,
            nullable: None,
            source_table: None,
            source_column: None,
            source_schema: None,
            source_updatable: None,
        }
    }
    fn t(s: &str) -> Value {
        Value::Text {
            value: s.into(),
            truncated: false,
        }
    }
    fn render(
        format: FileFormat,
        options: &FileExportOptions,
        columns: &[ColumnMeta],
        rows: &[Vec<Value>],
    ) -> String {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out");
        export_rows(&path, format, options, columns, rows).unwrap();
        std::fs::read_to_string(path).unwrap()
    }

    fn sample() -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
        (
            vec![col("id"), col("note"), col("at")],
            vec![
                vec![
                    Value::Int { value: 1 },
                    t("say \"hi\", ok"),
                    Value::Timestamptz {
                        value: "2026-10-08T21:14:07.5+02:00".into(),
                    },
                ],
                vec![Value::Int { value: 2 }, Value::Null, Value::Null],
            ],
        )
    }

    #[test]
    fn csv_quotes_fields_and_honours_header_delimiter_and_null_text() {
        let (c, r) = sample();
        let out = render(FileFormat::Csv, &FileExportOptions::default(), &c, &r);
        assert_eq!(
            out,
            "id,note,at\r\n1,\"say \"\"hi\"\", ok\",2026-10-08T21:14:07.5+02:00\r\n2,,\r\n"
        );
        let custom = FileExportOptions {
            header: false,
            delimiter: Some(";".into()),
            null_text: "\\N".into(),
            ..FileExportOptions::default()
        };
        assert_eq!(
            render(FileFormat::Csv, &custom, &c, &r),
            "1;\"say \"\"hi\"\", ok\";2026-10-08T21:14:07.5+02:00\r\n2;\\N;\\N\r\n"
        );
    }

    #[test]
    fn tsv_keeps_every_record_on_one_line() {
        let rows = vec![vec![t("a\tb\nc"), Value::Null]];
        let out = render(
            FileFormat::Tsv,
            &FileExportOptions::default(),
            &[col("x"), col("y")],
            &rows,
        );
        assert_eq!(out, "x\ty\na b c\t\n");
    }

    #[test]
    fn json_and_json_lines_keep_types() {
        let (c, r) = sample();
        let out = render(FileFormat::Json, &FileExportOptions::default(), &c, &r);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v[0]["id"], 1);
        assert_eq!(v[0]["note"], "say \"hi\", ok");
        assert_eq!(v[1]["note"], serde_json::Value::Null);
        assert_eq!(
            render(FileFormat::Json, &FileExportOptions::default(), &c, &[]),
            "[]\n"
        );
        let lines = render(FileFormat::Jsonl, &FileExportOptions::default(), &c, &r);
        assert_eq!(lines.lines().count(), 2);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines.lines().nth(1).unwrap()).unwrap()["id"],
            2
        );
    }

    #[test]
    fn json_values_use_native_json_types() {
        let rows = vec![vec![
            Value::Bool { value: true },
            Value::Float { value: 1.5 },
            Value::Json {
                value: serde_json::json!({"a": [1, 2]}),
            },
            Value::Decimal {
                value: "12.50".into(),
            },
        ]];
        let out = render(
            FileFormat::Jsonl,
            &FileExportOptions::default(),
            &[col("b"), col("f"), col("j"), col("d")],
            &rows,
        );
        assert_eq!(
            out.trim(),
            r#"{"b":true,"f":1.5,"j":{"a":[1,2]},"d":"12.50"}"#
        );
    }

    #[test]
    fn markdown_escapes_pipes_and_marks_null() {
        let rows = vec![vec![t("a|b"), Value::Null]];
        let out = render(
            FileFormat::Markdown,
            &FileExportOptions::default(),
            &[col("x"), col("y")],
            &rows,
        );
        assert_eq!(out, "| x | y |\n| --- | --- |\n| a\\|b | NULL |\n");
    }

    #[test]
    fn inserts_use_the_dialects_quoting_and_literals() {
        let rows = vec![vec![
            Value::Int { value: 1 },
            t("it's"),
            Value::Bool { value: true },
            Value::Bytes {
                value: "00ff".into(),
                len: 2,
                truncated: false,
            },
            Value::Null,
        ]];
        let cols = [col("id"), col("note"), col("ok"), col("blob"), col("x")];
        let pg = FileExportOptions {
            flavor: SqlFlavor::Postgres,
            table: Some("\"public\".\"orders\"".into()),
            ..FileExportOptions::default()
        };
        assert_eq!(
            render(FileFormat::Insert, &pg, &cols, &rows),
            "INSERT INTO \"public\".\"orders\" (\"id\", \"note\", \"ok\", \"blob\", \"x\") VALUES (1, 'it''s', TRUE, '\\x00ff', NULL);\n"
        );
        let my = FileExportOptions {
            flavor: SqlFlavor::Mysql,
            table: Some("`orders`".into()),
            ..FileExportOptions::default()
        };
        assert_eq!(
            render(FileFormat::Insert, &my, &cols, &rows),
            "INSERT INTO `orders` (`id`, `note`, `ok`, `blob`, `x`) VALUES (1, 'it''s', TRUE, X'00ff', NULL);\n"
        );
        let ms = FileExportOptions {
            flavor: SqlFlavor::Sqlserver,
            table: Some("[orders]".into()),
            ..FileExportOptions::default()
        };
        assert!(render(FileFormat::Insert, &ms, &cols, &rows)
            .contains("VALUES (1, 'it''s', 1, 0x00ff, NULL)"));
        assert_eq!(sql_literal(SqlFlavor::Mysql, &t("a\\b")), "'a\\\\b'");
        assert_eq!(
            sql_literal(
                SqlFlavor::Postgres,
                &Value::Decimal {
                    value: "NaN".into()
                }
            ),
            "'NaN'"
        );
    }

    #[test]
    fn date_formats() {
        let tz = Value::Timestamptz {
            value: "2026-10-08T21:14:07.5+02:00".into(),
        };
        let naive = Value::Timestamp {
            value: "2026-10-08T21:14:07".into(),
        };
        assert_eq!(
            cell_text(&tz, ExportDateFormat::Iso).unwrap(),
            "2026-10-08T21:14:07.5+02:00"
        );
        assert_eq!(
            cell_text(&tz, ExportDateFormat::Plain).unwrap(),
            "2026-10-08 21:14:07"
        );
        assert_eq!(
            cell_text(&naive, ExportDateFormat::Plain).unwrap(),
            "2026-10-08 21:14:07"
        );
        assert_eq!(
            cell_text(&tz, ExportDateFormat::Epoch).unwrap(),
            "1791486847"
        );
        assert_eq!(
            cell_text(&naive, ExportDateFormat::Epoch).unwrap(),
            "1791494047"
        );
        let z = Value::Timestamptz {
            value: "2026-10-08T19:14:07Z".into(),
        };
        assert_eq!(
            cell_text(&z, ExportDateFormat::Plain).unwrap(),
            "2026-10-08 19:14:07"
        );
        let date = Value::Date {
            value: "2026-10-08".into(),
        };
        assert_eq!(
            cell_text(&date, ExportDateFormat::Plain).unwrap(),
            "2026-10-08"
        );
    }

    #[test]
    fn extensions_and_flavors() {
        assert_eq!(FileFormat::Jsonl.extension(), "jsonl");
        assert_eq!(FileFormat::Insert.extension(), "sql");
        assert_eq!(SqlFlavor::of_driver("mariadb"), SqlFlavor::Mysql);
        assert_eq!(SqlFlavor::of_driver("duckdb"), SqlFlavor::Postgres);
        assert_eq!(SqlFlavor::Sqlserver.quote_ident("a]b"), "[a]]b]");
    }
}

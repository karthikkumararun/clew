//! The only things a model can do: look up schema (from the completion snapshot, never rows),
//! propose edits to the console text, and suggest follow-ups. Anything else is refused, and
//! nothing here can run a statement (spec: ai-assistant › Ask and Edit modes, Schema-grounded
//! context).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::context::{describe, find_table};
use super::providers::{ToolCall, ToolDef};
use crate::drivers::introspect::SchemaSnapshot;

/// Schema lookups allowed in one turn.
pub const MAX_TOOL_CALLS: usize = 8;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Ask,
    Edit,
}

/// Replace lines `start_line..=end_line` (1-based) of the console with `replacement`. An insertion
/// before line N has `end_line = N - 1`; an empty `replacement` deletes the lines.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEdit {
    pub start_line: u32,
    pub end_line: u32,
    pub replacement: String,
}

pub fn defs(mode: Mode) -> Vec<ToolDef> {
    let mut tools = vec![
        ToolDef {
            name: "list_tables",
            description: "List the tables and views of the connected database, optionally only those whose name contains `filter`. Returns names only.",
            schema: json!({
                "type": "object",
                "properties": { "filter": { "type": "string" } },
            }),
        },
        ToolDef {
            name: "describe_table",
            description: "Get the columns and types of one table or view, by name or schema.name.",
            schema: json!({
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "required": ["name"],
            }),
        },
        ToolDef {
            name: "suggest_followups",
            description: "Offer up to three short follow-up actions the user might want next, as buttons.",
            schema: json!({
                "type": "object",
                "properties": { "items": { "type": "array", "items": { "type": "string" }, "maxItems": 3 } },
                "required": ["items"],
            }),
        },
    ];
    if mode == Mode::Edit {
        tools.push(ToolDef {
            name: "edit_console",
            description: "Change the text of the user's console. Lines are numbered from 1 as shown in the console text. Each edit replaces start_line..=end_line with `replacement`; to insert before line N use end_line = N-1; an empty replacement deletes the lines. Edits must not overlap. The user reviews every change before it is kept; you cannot run anything.",
            schema: json!({
                "type": "object",
                "properties": {
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "start_line": { "type": "integer" },
                                "end_line": { "type": "integer" },
                                "replacement": { "type": "string" },
                            },
                            "required": ["start_line", "end_line", "replacement"],
                        },
                    },
                    "summary": { "type": "string" },
                },
                "required": ["edits"],
            }),
        });
    }
    tools
}

/// What a tool call produced.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// Text for the model; `read` names the table it was about, for the answer's header.
    Reply {
        content: String,
        read: Option<String>,
    },
    Edit {
        edits: Vec<LineEdit>,
        summary: String,
        content: String,
    },
    Suggestions {
        items: Vec<String>,
        content: String,
    },
    /// The call was not allowed; the model is told why.
    Refused {
        content: String,
    },
}

impl Outcome {
    pub fn content(&self) -> &str {
        match self {
            Outcome::Reply { content, .. }
            | Outcome::Edit { content, .. }
            | Outcome::Suggestions { content, .. }
            | Outcome::Refused { content } => content,
        }
    }
}

pub struct Toolbox<'a> {
    pub mode: Mode,
    pub snapshot: Option<&'a SchemaSnapshot>,
    pub schema_allowed: bool,
    /// The console text, for validating edits.
    pub console_text: Option<&'a str>,
    /// Schema lookups made so far this turn.
    pub used: usize,
}

fn refused(content: impl Into<String>) -> Outcome {
    Outcome::Refused {
        content: content.into(),
    }
}

impl Toolbox<'_> {
    pub fn run(&mut self, call: &ToolCall) -> Outcome {
        match call.name.as_str() {
            "list_tables" | "describe_table" => {
                if self.used >= MAX_TOOL_CALLS {
                    return refused(format!(
                        "Schema lookup limit reached ({MAX_TOOL_CALLS} per answer). Answer with what you have."
                    ));
                }
                self.used += 1;
                if !self.schema_allowed {
                    return refused("The user has turned off sharing the schema.");
                }
                let Some(snapshot) = self.snapshot else {
                    return refused("The connection isn't connected, so there is no schema to read.");
                };
                if call.name == "list_tables" {
                    list_tables(snapshot, call.args["filter"].as_str())
                } else {
                    describe_table(snapshot, call.args["name"].as_str().unwrap_or_default())
                }
            }
            "suggest_followups" => {
                let items: Vec<String> = call.args["items"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .take(3)
                            .collect()
                    })
                    .unwrap_or_default();
                Outcome::Suggestions {
                    content: "Shown to the user.".into(),
                    items,
                }
            }
            "edit_console" if self.mode == Mode::Edit => self.edit(&call.args),
            "edit_console" => refused("The assistant is in Ask mode and cannot change the console."),
            other => refused(format!(
                "There is no tool named {other}. Only list_tables, describe_table, suggest_followups{} exist; nothing can run a statement.",
                if self.mode == Mode::Edit { " and edit_console" } else { "" }
            )),
        }
    }

    fn edit(&self, args: &Value) -> Outcome {
        let Some(text) = self.console_text else {
            return refused("There is no console to edit.");
        };
        let Some(list) = args["edits"].as_array().filter(|a| !a.is_empty()) else {
            return refused("edit_console needs a non-empty `edits` list.");
        };
        let lines = line_count(text) as i64;
        let mut edits = Vec::new();
        for e in list {
            let (Some(start), Some(end), Some(rep)) = (
                e["start_line"].as_i64(),
                e["end_line"].as_i64(),
                e["replacement"].as_str(),
            ) else {
                return refused("Each edit needs start_line, end_line and replacement.");
            };
            if start < 1 || start > lines + 1 || end < start - 1 || end > lines {
                return refused(format!(
                    "Lines {start}-{end} are outside the console, which has {lines} line(s)."
                ));
            }
            edits.push(LineEdit {
                start_line: start as u32,
                end_line: end as u32,
                replacement: rep.to_string(),
            });
        }
        edits.sort_by_key(|e| (e.start_line, e.end_line));
        for pair in edits.windows(2) {
            // An insertion (end < start) occupies no lines; two edits overlap only when their
            // line ranges do.
            if pair[0].end_line >= pair[1].start_line && pair[0].end_line >= pair[0].start_line {
                return refused("Edits must not overlap. Merge them into one edit.");
            }
        }
        Outcome::Edit {
            summary: args["summary"].as_str().unwrap_or_default().to_string(),
            content: "The edits were written to the console as a pending diff for the user to review. Nothing has run.".into(),
            edits,
        }
    }
}

/// Lines of a text as the editor numbers them (an empty text has one).
pub fn line_count(text: &str) -> usize {
    text.split('\n').count()
}

/// Apply validated edits to `text`, the same way the editor does.
pub fn apply(text: &str, edits: &[LineEdit]) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut next = 1usize;
    for e in edits {
        let start = e.start_line as usize;
        let end = e.end_line as usize;
        out.extend(lines[next - 1..start - 1].iter().map(|l| l.to_string()));
        if !e.replacement.is_empty() {
            out.extend(e.replacement.split('\n').map(str::to_string));
        }
        next = (end + 1).max(start);
    }
    out.extend(lines[next - 1..].iter().map(|l| l.to_string()));
    out.join("\n")
}

fn list_tables(snapshot: &SchemaSnapshot, filter: Option<&str>) -> Outcome {
    let needle = filter.unwrap_or_default().to_lowercase();
    let multiple = snapshot.schemas.len() > 1;
    let names: Vec<String> = snapshot
        .schemas
        .iter()
        .flat_map(|s| {
            let needle = &needle;
            s.tables
                .iter()
                .filter(move |t| t.name.to_lowercase().contains(needle.as_str()))
                .map(move |t| {
                    if multiple {
                        format!("{}.{}", s.name, t.name)
                    } else {
                        t.name.clone()
                    }
                })
        })
        .take(200)
        .collect();
    Outcome::Reply {
        content: if names.is_empty() {
            "No tables match.".into()
        } else {
            names.join("\n")
        },
        read: None,
    }
}

fn describe_table(snapshot: &SchemaSnapshot, name: &str) -> Outcome {
    match find_table(snapshot, name) {
        Some((schema, table)) => Outcome::Reply {
            content: describe(schema, snapshot.schemas.len() > 1, table),
            read: Some(table.name.clone()),
        },
        None => Outcome::Reply {
            content: format!("No table named {name}."),
            read: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::introspect::{NodeKind, SnapshotColumn, SnapshotSchema, SnapshotTable};

    fn snapshot() -> SchemaSnapshot {
        SchemaSnapshot {
            schemas: vec![SnapshotSchema {
                name: "public".into(),
                tables: vec![
                    SnapshotTable {
                        name: "orders".into(),
                        kind: NodeKind::Table,
                        columns: vec![SnapshotColumn {
                            name: "id".into(),
                            type_name: "integer".into(),
                        }],
                    },
                    SnapshotTable {
                        name: "shipments".into(),
                        kind: NodeKind::Table,
                        columns: vec![SnapshotColumn {
                            name: "carrier".into(),
                            type_name: "text".into(),
                        }],
                    },
                ],
                functions: vec![],
            }],
            graph: None,
        }
    }

    fn call(name: &str, args: Value) -> ToolCall {
        ToolCall {
            id: "1".into(),
            name: name.into(),
            args,
        }
    }

    fn toolbox<'a>(snap: &'a SchemaSnapshot, mode: Mode, text: Option<&'a str>) -> Toolbox<'a> {
        Toolbox {
            mode,
            snapshot: Some(snap),
            schema_allowed: true,
            console_text: text,
            used: 0,
        }
    }

    /// (spec: ai-assistant › Model asks for another table)
    #[test]
    fn describe_table_answers_from_the_snapshot_and_names_what_was_read() {
        let snap = snapshot();
        let out = toolbox(&snap, Mode::Ask, None)
            .run(&call("describe_table", json!({"name":"shipments"})));
        assert_eq!(
            out,
            Outcome::Reply {
                content: "shipments (table): carrier text".into(),
                read: Some("shipments".into())
            }
        );
    }

    #[test]
    fn list_tables_filters_by_name() {
        let snap = snapshot();
        let out =
            toolbox(&snap, Mode::Ask, None).run(&call("list_tables", json!({"filter":"ship"})));
        assert_eq!(out.content(), "shipments");
    }

    /// (spec: ai-assistant › No row access)
    #[test]
    fn any_other_tool_is_refused_and_the_model_is_told_what_exists() {
        let snap = snapshot();
        for name in ["run_sql", "execute", "query", "select_rows"] {
            let out = toolbox(&snap, Mode::Edit, Some("x"))
                .run(&call(name, json!({"sql":"DROP TABLE orders"})));
            let Outcome::Refused { content } = out else {
                panic!("{name} was not refused")
            };
            assert!(content.contains("Only list_tables"), "{content}");
            assert!(content.contains("nothing can run a statement"));
        }
    }

    #[test]
    fn schema_lookups_stop_after_eight_calls() {
        let snap = snapshot();
        let mut t = toolbox(&snap, Mode::Ask, None);
        for _ in 0..MAX_TOOL_CALLS {
            assert!(matches!(
                t.run(&call("list_tables", json!({}))),
                Outcome::Reply { .. }
            ));
        }
        let Outcome::Refused { content } = t.run(&call("list_tables", json!({}))) else {
            panic!()
        };
        assert!(content.contains("limit"));
    }

    #[test]
    fn schema_tools_say_so_when_sharing_the_schema_is_off() {
        let snap = snapshot();
        let mut t = toolbox(&snap, Mode::Ask, None);
        t.schema_allowed = false;
        assert!(matches!(
            t.run(&call("describe_table", json!({"name":"orders"}))),
            Outcome::Refused { .. }
        ));
    }

    #[test]
    fn ask_mode_has_no_edit_tool_and_refuses_it() {
        assert!(defs(Mode::Ask).iter().all(|d| d.name != "edit_console"));
        assert!(defs(Mode::Edit).iter().any(|d| d.name == "edit_console"));
        let snap = snapshot();
        let out = toolbox(&snap, Mode::Ask, Some("select 1")).run(&call(
            "edit_console",
            json!({"edits":[{"start_line":1,"end_line":1,"replacement":"x"}]}),
        ));
        assert!(matches!(out, Outcome::Refused { .. }));
    }

    #[test]
    fn valid_edits_are_returned_sorted() {
        let snap = snapshot();
        let out = toolbox(&snap, Mode::Edit, Some("a\nb\nc\nd")).run(&call(
            "edit_console",
            json!({"summary":"s","edits":[
                {"start_line":4,"end_line":4,"replacement":"D"},
                {"start_line":1,"end_line":2,"replacement":"AB"}
            ]}),
        ));
        let Outcome::Edit { edits, summary, .. } = out else {
            panic!("{out:?}")
        };
        assert_eq!(summary, "s");
        assert_eq!(
            edits.iter().map(|e| e.start_line).collect::<Vec<_>>(),
            vec![1, 4]
        );
    }

    #[test]
    fn out_of_range_and_overlapping_edits_are_refused() {
        let snap = snapshot();
        let run = |edits: Value| {
            toolbox(&snap, Mode::Edit, Some("a\nb\nc"))
                .run(&call("edit_console", json!({ "edits": edits })))
        };
        assert!(matches!(
            run(json!([{"start_line":0,"end_line":1,"replacement":"x"}])),
            Outcome::Refused { .. }
        ));
        assert!(matches!(
            run(json!([{"start_line":2,"end_line":9,"replacement":"x"}])),
            Outcome::Refused { .. }
        ));
        assert!(matches!(run(json!([])), Outcome::Refused { .. }));
        let overlap = run(json!([
            {"start_line":1,"end_line":2,"replacement":"x"},
            {"start_line":2,"end_line":3,"replacement":"y"}
        ]));
        let Outcome::Refused { content } = overlap else {
            panic!()
        };
        assert!(content.contains("overlap"));
        // Appending after the last line is fine, and so is an insertion in the middle.
        assert!(matches!(
            run(json!([{"start_line":4,"end_line":3,"replacement":"d"}])),
            Outcome::Edit { .. }
        ));
        assert!(matches!(
            run(json!([
                {"start_line":2,"end_line":1,"replacement":"new"},
                {"start_line":2,"end_line":2,"replacement":"B"}
            ])),
            Outcome::Edit { .. }
        ));
    }

    #[test]
    fn apply_replaces_inserts_and_appends() {
        let e = |s, en, r: &str| LineEdit {
            start_line: s,
            end_line: en,
            replacement: r.into(),
        };
        assert_eq!(apply("a\nb\nc", &[e(2, 2, "B")]), "a\nB\nc");
        assert_eq!(apply("a\nb\nc", &[e(1, 2, "X\nY\nZ")]), "X\nY\nZ\nc");
        assert_eq!(apply("a\nb\nc", &[e(2, 1, "new")]), "a\nnew\nb\nc");
        assert_eq!(apply("a\nb\nc", &[e(4, 3, "d")]), "a\nb\nc\nd");
        assert_eq!(apply("a\nb\nc", &[e(1, 1, "A"), e(3, 3, "C")]), "A\nb\nC");
        assert_eq!(apply("a\nb\nc", &[e(2, 3, "")]), "a");
        assert_eq!(apply("a\nb\nc", &[e(1, 1, "")]), "b\nc");
    }

    #[test]
    fn suggestions_are_trimmed_and_capped_at_three() {
        let snap = snapshot();
        let out = toolbox(&snap, Mode::Ask, None).run(&call(
            "suggest_followups",
            json!({"items":[" a ", "", "b", "c", "d"]}),
        ));
        let Outcome::Suggestions { items, .. } = out else {
            panic!()
        };
        assert_eq!(items, vec!["a", "b", "c"]);
    }
}

//! A tiny XML tree, enough to read DataGrip's settings files without caring about their layout.

use std::collections::BTreeMap;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

#[derive(Debug, Clone, Default)]
pub struct Node {
    pub name: String,
    pub attrs: BTreeMap<String, String>,
    pub text: String,
    pub children: Vec<Node>,
}

fn element(start: &BytesStart<'_>) -> Node {
    let mut node = Node {
        name: String::from_utf8_lossy(start.name().as_ref()).into_owned(),
        ..Default::default()
    };
    for attr in start.attributes().flatten() {
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let value = attr
            .unescape_value()
            .map(|v| v.into_owned())
            .unwrap_or_default();
        node.attrs.insert(key, value);
    }
    node
}

/// Parse a document into its root element. Malformed input is an error; unknown content is kept.
pub fn parse(text: &str) -> Result<Node, String> {
    let mut reader = Reader::from_str(text);
    let mut stack: Vec<Node> = vec![Node::default()];
    loop {
        match reader.read_event() {
            Ok(Event::Start(s)) => stack.push(element(&s)),
            Ok(Event::Empty(s)) => {
                let node = element(&s);
                stack.last_mut().expect("root").children.push(node);
            }
            Ok(Event::Text(t)) => {
                if let Ok(t) = t.unescape() {
                    stack.last_mut().expect("root").text.push_str(&t);
                }
            }
            Ok(Event::CData(c)) => {
                stack
                    .last_mut()
                    .expect("root")
                    .text
                    .push_str(&String::from_utf8_lossy(&c));
            }
            Ok(Event::End(_)) => {
                if stack.len() < 2 {
                    return Err("unbalanced XML".into());
                }
                let node = stack.pop().expect("checked");
                stack.last_mut().expect("root").children.push(node);
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    if stack.len() != 1 {
        return Err("unterminated XML".into());
    }
    let mut doc = stack.pop().expect("root");
    doc.children
        .pop()
        .ok_or_else(|| "empty document".to_string())
}

impl Node {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }

    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    /// Trimmed text of the first child with this name.
    pub fn child_text(&self, name: &str) -> Option<String> {
        let t = self.child(name)?.text.trim().to_string();
        (!t.is_empty()).then_some(t)
    }

    /// Every descendant (depth-first, not including self) with this name.
    pub fn descendants<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        for c in &self.children {
            if c.name == name {
                out.push(c);
            }
            c.descendants(name, out);
        }
    }

    pub fn find_all(&self, name: &str) -> Vec<&Node> {
        let mut out = Vec::new();
        self.descendants(name, &mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_attributes_text_and_nesting() {
        let doc = parse(
            r#"<?xml version="1.0"?><a x="1"><b>hi &amp; bye</b><c y="2"/><d><b>deep</b></d></a>"#,
        )
        .unwrap();
        assert_eq!(doc.attr("x"), Some("1"));
        assert_eq!(doc.child_text("b").as_deref(), Some("hi & bye"));
        assert_eq!(doc.child("c").unwrap().attr("y"), Some("2"));
        assert_eq!(doc.find_all("b").len(), 2);
    }

    #[test]
    fn malformed_input_is_an_error() {
        assert!(parse("<a><b></a>").is_err());
        assert!(parse("").is_err());
    }
}

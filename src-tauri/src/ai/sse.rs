//! A small incremental Server-Sent Events parser for the two chat APIs.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

#[derive(Debug, Default)]
pub struct SseParser {
    /// Bytes of the line being read (a chunk can end in the middle of a line or a character).
    line: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    /// Feed bytes; returns the events completed by them.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        for &b in bytes {
            if b != b'\n' {
                self.line.push(b);
                continue;
            }
            let raw = std::mem::take(&mut self.line);
            let line = String::from_utf8_lossy(&raw);
            let line = line.strip_suffix('\r').unwrap_or(&line);
            if line.is_empty() {
                if !self.data.is_empty() || self.event.is_some() {
                    out.push(SseEvent {
                        event: self.event.take(),
                        data: self.data.join("\n"),
                    });
                    self.data.clear();
                }
                continue;
            }
            if line.starts_with(':') {
                continue; // a comment / keep-alive
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line, ""),
            };
            match field {
                "event" => self.event = Some(value.to_string()),
                "data" => self.data.push(value.to_string()),
                _ => {}
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_split_anywhere() {
        let text =
            "event: a\ndata: {\"x\":1}\n\ndata: two\ndata: lines\n\n: ping\n\ndata: [DONE]\n\n";
        let whole = SseParser::default().push(text.as_bytes());
        assert_eq!(whole.len(), 3);
        assert_eq!(whole[0].event.as_deref(), Some("a"));
        assert_eq!(whole[0].data, "{\"x\":1}");
        assert_eq!(whole[1].data, "two\nlines");
        assert_eq!(whole[2].data, "[DONE]");
        // One byte at a time gives the same events.
        let mut p = SseParser::default();
        let mut bytewise = Vec::new();
        for b in text.as_bytes() {
            bytewise.extend(p.push(&[*b]));
        }
        assert_eq!(bytewise, whole);
    }

    #[test]
    fn handles_crlf_and_multibyte_characters_split_across_chunks() {
        let text = "data: héllo\r\n\r\n";
        let bytes = text.as_bytes();
        let mut p = SseParser::default();
        let mut got = p.push(&bytes[..7]); // ends inside "é"
        got.extend(p.push(&bytes[7..]));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].data, "héllo");
    }
}

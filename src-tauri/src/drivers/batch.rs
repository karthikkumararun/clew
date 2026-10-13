use super::{Value, BATCH_BYTE_CAP};

/// Rough serialized size of a value, enough to enforce the batch byte cap.
pub fn approx_size(v: &Value) -> usize {
    match v {
        Value::Null => 4,
        Value::Bool { .. } => 5,
        Value::Int { .. } | Value::Float { .. } => 12,
        Value::Bigint { value }
        | Value::Decimal { value }
        | Value::Date { value }
        | Value::Time { value }
        | Value::Timestamp { value }
        | Value::Timestamptz { value }
        | Value::Interval { value }
        | Value::Uuid { value } => value.len() + 8,
        Value::Text { value, .. } | Value::Bytes { value, .. } => value.len() + 8,
        Value::Json { value } => value.to_string().len() + 8,
        Value::Array { value } => value.iter().map(approx_size).sum::<usize>() + 8,
        Value::Other { value, type_name } => value.len() + type_name.len() + 16,
        // graph values: a rough size from their JSON form, cheap enough for the few that show up
        Value::Node { .. } | Value::Relationship { .. } | Value::Path { .. } => {
            serde_json::to_string(v).map_or(64, |s| s.len())
        }
    }
}

/// Accumulates rows and tells the driver when to send a batch: after `page_size` rows or
/// `BATCH_BYTE_CAP` bytes, whichever comes first (so very wide rows flush early).
#[derive(Debug)]
pub struct RowBatcher {
    page_size: usize,
    byte_cap: usize,
    rows: Vec<Vec<Value>>,
    bytes: usize,
}

impl RowBatcher {
    pub fn new(page_size: usize) -> Self {
        Self::with_byte_cap(page_size, BATCH_BYTE_CAP)
    }

    pub fn with_byte_cap(page_size: usize, byte_cap: usize) -> Self {
        Self {
            page_size: page_size.max(1),
            byte_cap,
            rows: Vec::new(),
            bytes: 0,
        }
    }

    /// Add a row. Returns a full batch when one is ready.
    pub fn push(&mut self, row: Vec<Value>) -> Option<Vec<Vec<Value>>> {
        self.bytes += row.iter().map(approx_size).sum::<usize>();
        self.rows.push(row);
        (self.rows.len() >= self.page_size || self.bytes >= self.byte_cap).then(|| self.take())
    }

    /// The remaining rows, if any.
    pub fn finish(&mut self) -> Option<Vec<Vec<Value>>> {
        (!self.rows.is_empty()).then(|| self.take())
    }

    fn take(&mut self) -> Vec<Vec<Value>> {
        self.bytes = 0;
        std::mem::take(&mut self.rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(n: i64) -> Vec<Value> {
        vec![Value::from_i64(n)]
    }

    #[test]
    fn flushes_every_page_size_rows() {
        let mut b = RowBatcher::new(500);
        let mut batches = Vec::new();
        for i in 0..1200 {
            if let Some(batch) = b.push(row(i)) {
                batches.push(batch.len());
            }
        }
        batches.extend(b.finish().map(|r| r.len()));
        assert_eq!(batches, [500, 500, 200]);
    }

    #[test]
    fn wide_rows_flush_early_by_bytes() {
        let mut b = RowBatcher::with_byte_cap(500, 1000);
        let wide = || vec![Value::text("x".repeat(400))];
        assert!(b.push(wide()).is_none());
        assert!(b.push(wide()).is_none());
        let batch = b.push(wide()).expect("third row crosses the cap");
        assert_eq!(batch.len(), 3);
    }

    #[test]
    fn the_default_cap_is_two_megabytes() {
        let mut b = RowBatcher::new(10_000);
        let wide = || vec![Value::text("x".repeat(512 * 1024))];
        for _ in 0..3 {
            assert!(b.push(wide()).is_none());
        }
        assert_eq!(b.push(wide()).expect("2 MB reached").len(), 4);
    }

    #[test]
    fn finish_on_empty_returns_nothing() {
        assert!(RowBatcher::new(5).finish().is_none());
    }

    #[test]
    fn a_page_size_of_zero_still_makes_progress() {
        let mut b = RowBatcher::new(0);
        assert_eq!(b.push(row(1)).unwrap().len(), 1);
    }
}

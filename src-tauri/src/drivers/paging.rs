//! Paged result streaming shared by the SQL drivers.
//!
//! A driver runs the statement in a task that owns the connection and pushes rows into a bounded
//! channel; the session keeps the receiver in an [`OpenStream`]. `read_page` hands out one page at
//! a time and peeks one row ahead so the result can say whether more rows remain.

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::batch::RowBatcher;
use super::{DriverError, ResultEvent, ResultId, ResultSink, Value};

/// Rows buffered ahead of the consumer (and therefore the server, via back-pressure).
pub const STREAM_BUFFER: usize = 64;

#[derive(Debug)]
pub enum Msg {
    Row(Vec<Value>),
    End,
    Err(DriverError),
}

/// An open, possibly paused result. `C` is the connection type the task hands back.
pub struct OpenStream<C> {
    pub result_id: ResultId,
    pub rx: mpsc::Receiver<Msg>,
    pub task: JoinHandle<C>,
    peeked: Option<Msg>,
}

impl<C> OpenStream<C> {
    pub fn new(result_id: ResultId, rx: mpsc::Receiver<Msg>, task: JoinHandle<C>) -> Self {
        Self {
            result_id,
            rx,
            task,
            peeked: None,
        }
    }
}

/// What happened while reading a page.
#[derive(Debug, Default)]
pub struct PageOutcome {
    /// The result ended (normally or with an error): the task has finished or is about to.
    pub finished: bool,
    pub has_more: bool,
    pub error: Option<DriverError>,
    /// The frontend stopped listening.
    pub receiver_gone: bool,
}

/// Send up to `count` rows as batches, then peek whether the result continues.
pub async fn read_page<C>(
    stream: &mut OpenStream<C>,
    count: usize,
    sink: &ResultSink,
) -> PageOutcome {
    let result_id = stream.result_id;
    let mut out = PageOutcome::default();
    let mut batcher = RowBatcher::new(count);
    let mut sent = 0usize;

    while sent < count {
        let msg = match stream.peeked.take() {
            Some(m) => Some(m),
            None => stream.rx.recv().await,
        };
        match msg {
            Some(Msg::Row(row)) => {
                sent += 1;
                if let Some(batch) = batcher.push(row) {
                    if !sink
                        .send(ResultEvent::Rows {
                            result_id,
                            rows: batch,
                        })
                        .await
                    {
                        out.receiver_gone = true;
                        break;
                    }
                }
            }
            Some(Msg::End) | None => {
                out.finished = true;
                break;
            }
            Some(Msg::Err(e)) => {
                out.error = Some(e);
                out.finished = true;
                break;
            }
        }
    }
    if let Some(batch) = batcher.finish() {
        if !sink
            .send(ResultEvent::Rows {
                result_id,
                rows: batch,
            })
            .await
        {
            out.receiver_gone = true;
        }
    }
    // The page is full: peek one more message to learn whether the result continues.
    if !out.finished && !out.receiver_gone {
        match stream.rx.recv().await {
            Some(Msg::Row(row)) => {
                stream.peeked = Some(Msg::Row(row));
                out.has_more = true;
            }
            Some(Msg::End) | None => out.finished = true,
            Some(Msg::Err(e)) => {
                out.error = Some(e);
                out.finished = true;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::ResultSink;

    fn rows(n: usize) -> Vec<Msg> {
        (0..n)
            .map(|i| Msg::Row(vec![Value::from_i64(i as i64)]))
            .collect()
    }

    async fn feed(msgs: Vec<Msg>) -> OpenStream<()> {
        let (tx, rx) = mpsc::channel(msgs.len() + 1);
        for m in msgs {
            tx.send(m).await.unwrap();
        }
        // keep the sender alive inside the task so the channel stays open until the stream ends
        let task = tokio::spawn(async move {
            drop(tx);
        });
        OpenStream::new(1, rx, task)
    }

    async fn collect(rx: &mut mpsc::Receiver<ResultEvent>) -> Vec<usize> {
        let mut sizes = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let ResultEvent::Rows { rows, .. } = ev {
                sizes.push(rows.len());
            }
        }
        sizes
    }

    #[tokio::test]
    async fn pages_and_peeks_for_more() {
        let mut msgs = rows(7);
        msgs.push(Msg::End);
        let mut s = feed(msgs).await;
        let (sink, mut rx) = ResultSink::channel(64);
        let p1 = read_page(&mut s, 3, &sink).await;
        assert!(p1.has_more && !p1.finished);
        assert_eq!(collect(&mut rx).await, [3]);
        let p2 = read_page(&mut s, 3, &sink).await;
        assert!(p2.has_more);
        let p3 = read_page(&mut s, 3, &sink).await;
        assert!(!p3.has_more && p3.finished && p3.error.is_none());
        assert_eq!(collect(&mut rx).await, [3, 1]);
    }

    #[tokio::test]
    async fn an_exact_multiple_of_the_page_size_ends_cleanly() {
        let mut msgs = rows(4);
        msgs.push(Msg::End);
        let mut s = feed(msgs).await;
        let (sink, _rx) = ResultSink::channel(64);
        let p = read_page(&mut s, 4, &sink).await;
        assert!(!p.has_more && p.finished);
    }

    #[tokio::test]
    async fn an_error_mid_page_keeps_the_rows_already_read() {
        let mut msgs = rows(2);
        msgs.push(Msg::Err(DriverError::new(
            crate::drivers::ErrorCode::Cancelled,
            "cancelled",
        )));
        let mut s = feed(msgs).await;
        let (sink, mut rx) = ResultSink::channel(64);
        let p = read_page(&mut s, 10, &sink).await;
        assert!(p.finished);
        assert_eq!(p.error.unwrap().code, crate::drivers::ErrorCode::Cancelled);
        assert_eq!(collect(&mut rx).await, [2]);
    }

    #[tokio::test]
    async fn a_closed_channel_is_the_end_of_the_result() {
        let mut s = feed(rows(1)).await;
        let (sink, _rx) = ResultSink::channel(64);
        let p = read_page(&mut s, 10, &sink).await;
        assert!(p.finished && !p.has_more);
    }

    #[tokio::test]
    async fn a_gone_receiver_stops_reading() {
        let mut s = feed(rows(10)).await;
        let (sink, rx) = ResultSink::channel(1);
        drop(rx);
        let p = read_page(&mut s, 2, &sink).await;
        assert!(p.receiver_gone);
    }
}

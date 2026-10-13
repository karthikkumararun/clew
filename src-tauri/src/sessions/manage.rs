//! Session management for the Sessions panel: listing and subscribing to session meta, labelling,
//! sharing a session between tabs, ending transactions, closing sessions and isolation.

use std::sync::Arc;

use tokio::sync::broadcast;

use super::*;

/// A statement the manager sends on its own behalf (COMMIT, ROLLBACK), results discarded.
fn control(sql: &str) -> ExecRequest {
    ExecRequest {
        sql: sql.to_string(),
        page_size: 1,
        script: false,
        continue_on_error: false,
    }
}

impl SessionManager {
    /// Every session's meta, oldest first.
    pub fn sessions_list(&self) -> Vec<SessionMeta> {
        let entries: Vec<Arc<SessionEntry>> = self
            .inner
            .lock()
            .unwrap()
            .sessions
            .values()
            .cloned()
            .collect();
        let mut metas: Vec<SessionMeta> = entries.iter().map(|e| e.meta()).collect();
        metas.sort_by(|a, b| {
            a.started_at
                .cmp(&b.started_at)
                .then_with(|| id_number(&a.id).cmp(&id_number(&b.id)))
        });
        metas
    }

    /// Attach to the stream of session changes. The receiver is created before the snapshot is
    /// taken, so nothing between them is lost (an update may arrive twice, which is harmless).
    pub fn subscribe(&self) -> (Vec<SessionMeta>, broadcast::Receiver<SessionEvent>) {
        let rx = self.events.subscribe();
        (self.sessions_list(), rx)
    }

    /// Sessions with an open transaction on any connection (aborted ones included), for the quit
    /// dialog and the idle-in-transaction warnings.
    pub fn sessions_open_transactions(&self) -> Vec<SessionMeta> {
        let entries: Vec<Arc<SessionEntry>> = self
            .inner
            .lock()
            .unwrap()
            .sessions
            .values()
            .cloned()
            .collect();
        let mut open: Vec<SessionMeta> = entries
            .iter()
            .filter(|e| e.meta.lock().unwrap().tx_open())
            .map(|e| e.meta())
            .collect();
        open.sort_by_key(|m| (m.started_at, id_number(&m.id)));
        open
    }

    /// Label a session with the name (and owning tab) the editor shows for it.
    pub fn set_session_meta(
        &self,
        session_id: &str,
        name: Option<String>,
        tab_id: Option<String>,
    ) -> DriverResult<()> {
        let entry = self.session(session_id)?;
        entry.update(|c| {
            if let Some(name) = name.filter(|n| !n.trim().is_empty()) {
                c.meta.name = name;
            }
            if let Some(tab) = tab_id {
                c.meta.shared_with.retain(|t| *t != tab);
                c.meta.tab_id = Some(tab);
            }
        });
        Ok(())
    }

    /// Let another tab use this session: it shares the transaction, temporary tables and
    /// settings, and its statements queue behind the session's.
    pub fn attach_tab(&self, session_id: &str, tab_id: &str) -> DriverResult<()> {
        let entry = self.session(session_id)?;
        entry.update(|c| {
            if c.meta.tab_id.is_none() {
                c.meta.tab_id = Some(tab_id.to_string());
            } else if c.meta.tab_id.as_deref() != Some(tab_id)
                && !c.meta.shared_with.iter().any(|t| t == tab_id)
            {
                c.meta.shared_with.push(tab_id.to_string());
            }
        });
        Ok(())
    }

    /// A tab stopped using the session. When it was the last tab known to use it, the session
    /// closes. Returns whether it did.
    pub async fn detach_tab(&self, session_id: &str, tab_id: &str) -> DriverResult<bool> {
        let entry = self.session(session_id)?;
        let last = entry.update(|c| {
            if c.meta.tab_id.as_deref() == Some(tab_id) {
                c.meta.tab_id = if c.meta.shared_with.is_empty() {
                    None
                } else {
                    Some(c.meta.shared_with.remove(0))
                };
                c.meta.tab_id.is_none()
            } else {
                c.meta.shared_with.retain(|t| t != tab_id);
                false
            }
        });
        if last {
            self.close_session(session_id).await?;
        }
        Ok(last)
    }

    /// Commit the session's transaction (runs `COMMIT` like a typed statement).
    pub async fn session_commit(&self, session_id: &str) -> DriverResult<()> {
        self.end_session_transaction(session_id, TxAction::Commit)
            .await
    }

    /// Roll the session's transaction back (runs `ROLLBACK`; clears an aborted transaction).
    pub async fn session_rollback(&self, session_id: &str) -> DriverResult<()> {
        self.end_session_transaction(session_id, TxAction::Rollback)
            .await
    }

    async fn end_session_transaction(
        &self,
        session_id: &str,
        action: TxAction,
    ) -> DriverResult<()> {
        let emit: Emit = Arc::new(|_| true);
        self.execute(session_id, control(action.sql()), emit)
            .await
            .map(|_| ())
    }

    /// Close the session's connection but keep the session (and its tab): it reconnects the next
    /// time it is used. An open transaction is first committed or rolled back as `tx_action` says
    /// (absent: the server rolls it back as the connection closes). A running statement is
    /// cancelled unless the transaction is to be committed.
    pub async fn disconnect_session(
        &self,
        session_id: &str,
        tx_action: Option<TxAction>,
    ) -> DriverResult<()> {
        let entry = self.session(session_id)?;
        let in_tx = entry.meta.lock().unwrap().tx_open();
        match tx_action {
            Some(action) if in_tx => {
                self.end_session_transaction(session_id, action).await?;
            }
            _ => {
                let handle = entry.cancel.lock().unwrap().clone();
                let _ = handle.cancel().await;
            }
        }
        let mut st = entry.state.lock().await;
        if let Some(session) = st.session.take() {
            let _ = session.close().await;
        }
        st.in_transaction = false;
        st.closed_on_purpose = true;
        entry.update(|c| c.set_disconnected(now_ms()));
        Ok(())
    }

    /// [`Self::disconnect_session`] for every session of the connection ("Close all sessions").
    pub async fn disconnect_sessions_of(
        &self,
        connection_id: &str,
        tx_action: Option<TxAction>,
    ) -> DriverResult<()> {
        let ids: Vec<SessionId> = self
            .inner
            .lock()
            .unwrap()
            .sessions
            .iter()
            .filter(|(_, s)| s.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.disconnect_session(&id, tx_action).await?;
        }
        Ok(())
    }

    /// Set the isolation level of the session's next transaction (now, when idle). Refused while a
    /// transaction is open: the caller commits or rolls back first.
    pub async fn set_session_isolation(&self, session_id: &str, level: &str) -> DriverResult<()> {
        let entry = self.session(session_id)?;
        let mut st = Self::lock_session(&entry).await;
        Self::touch(&entry);
        if st.in_transaction {
            return Err(DriverError::new(
                ErrorCode::QueryFailed,
                "Commit or roll back the open transaction before changing the isolation level",
            ));
        }
        if st.session.is_none() {
            // Not connected: it applies when the session reconnects.
            let supported = entry.meta.lock().unwrap().meta.supported_isolation.clone();
            let found = supported
                .iter()
                .find(|l| l.eq_ignore_ascii_case(level.trim()))
                .cloned()
                .ok_or_else(|| {
                    DriverError::unsupported("Setting the isolation level to this value")
                })?;
            st.isolation = Some(found.clone());
            entry.update(|c| c.meta.isolation = Some(found));
            return Ok(());
        }
        let session = st.session.as_mut().expect("session present");
        let canonical = canonical_isolation(session.supported_isolation_levels(), level)?;
        session.set_isolation(canonical).await?;
        st.isolation = Some(canonical.to_string());
        entry.update(|c| c.meta.isolation = Some(canonical.to_string()));
        Ok(())
    }
}

fn id_number(id: &str) -> u64 {
    id.rsplit('-')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

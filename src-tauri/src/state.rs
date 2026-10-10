use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::connections::service::{ConnectionService, PendingPasswords};
use crate::drivers::registry::Registry;
use crate::sessions::SessionManager;
use crate::store::Store;
use crate::transport::hostkey::PendingPrompts;

/// Shared application state managed by Tauri. Grows as later changes add services.
#[derive(Debug)]
pub struct AppState {
    /// `<platform data dir>/Clew`
    pub data_dir: PathBuf,
    pub store: Store,
    pub registry: Arc<Registry>,
    pub sessions: Arc<SessionManager>,
    pub host_key_prompts: Arc<PendingPrompts>,
    pub connections: Arc<ConnectionService>,
    pub password_prompts: Arc<PendingPasswords>,
    /// Running "Test connection" attempts, by id, so the dialog can cancel them.
    pub test_cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Which files the WebView may read and write (see `files.rs`).
    pub files: crate::files::FileAccess,
}

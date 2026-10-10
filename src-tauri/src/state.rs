use std::path::PathBuf;
use std::sync::Arc;

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
}

use std::path::PathBuf;

use crate::store::Store;

/// Shared application state managed by Tauri. Grows as later changes add services.
#[derive(Debug)]
pub struct AppState {
    /// `<platform data dir>/Clew`
    pub data_dir: PathBuf,
    pub store: Store,
}

//! Tauri command handlers. Keep them thin; delegate to services.
pub mod ai;
pub mod app;
pub mod connections;
pub mod drivers;
pub mod export;
pub mod files;
pub mod graph;
pub mod palette;
pub mod results;
pub mod sessions;
pub mod settings;
pub mod ui_state;

/// End-to-end builds answer native file dialogs from the test's queue instead of opening them
/// (`Some(None)` = cancelled). Other builds always get `None` and open the real dialog.
pub fn scripted_dialog() -> Option<Option<tauri_plugin_dialog::FilePath>> {
    #[cfg(feature = "e2e")]
    if crate::testmode::active() {
        return Some(
            crate::testmode::next_dialog_answer()
                .map(|p| tauri_plugin_dialog::FilePath::Path(p.into())),
        );
    }
    None
}

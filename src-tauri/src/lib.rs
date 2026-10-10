pub mod commands;
pub mod error;
pub mod paths;
pub mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![commands::app::app_paths])
        .run(tauri::generate_context!())
        .expect("error while running Clew");
}

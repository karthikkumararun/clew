pub mod commands;
pub mod error;
pub mod paths;
pub mod settings;
pub mod state;
pub mod store;
pub mod window;

use tauri::{Manager, PhysicalPosition};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::window::Rect;

/// If the restored window is not reachable on any current display, centre it on the primary one.
fn correct_off_screen(window: &tauri::WebviewWindow) {
    let (Ok(pos), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return;
    };
    let rects: Vec<Rect> = monitors
        .iter()
        .map(|m| Rect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect();
    let current = Rect {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    };
    if window::is_reachable(current, &rects) {
        return;
    }
    if let Ok(Some(primary)) = window.primary_monitor() {
        let x = primary.position().x + (primary.size().width as i32 - size.width as i32).max(0) / 2;
        let y =
            primary.position().y + (primary.size().height as i32 - size.height as i32).max(0) / 2;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    } else {
        let _ = window.center();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let data_dir = paths::app_data_dir(&app.path().data_dir()?);
            let store = tauri::async_runtime::block_on(store::Store::open(&data_dir))?;
            app.manage(state::AppState { data_dir, store });
            if let Some(window) = app.get_webview_window("main") {
                correct_off_screen(&window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let _ = window.app_handle().save_window_state(StateFlags::all());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_paths,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::ui_state::ui_state_get,
            commands::ui_state::ui_state_set,
            commands::ui_state::ui_state_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clew");
}

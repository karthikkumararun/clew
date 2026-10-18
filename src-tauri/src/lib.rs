pub mod ai;
pub mod applog;
pub mod changes;
pub mod cli;
pub mod commands;
pub mod connections;
pub mod diagnostics;
pub mod drivers;
pub mod editability;
pub mod error;
pub mod exporter;
pub mod files;
pub mod history;
pub mod palette;
pub mod paths;
pub mod safety;
pub mod sessions;
pub mod settings;
pub mod state;
pub mod store;
pub mod table_query;
#[cfg(feature = "e2e")]
pub mod testmode;
pub mod transport;
pub mod window;

use std::sync::Arc;
use std::time::Duration;

use tauri::{Emitter, Manager, PhysicalPosition};
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

/// Close sessions that have sat idle for longer than the idle timeout.
fn spawn_idle_sweeper(sessions: Arc<sessions::SessionManager>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            sessions.sweep_idle(sessions::IDLE_TIMEOUT).await;
        }
    });
}

fn resolve_data_dir(app: &tauri::App) -> tauri::Result<std::path::PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(dir) = testmode::data_dir_override() {
        std::fs::create_dir_all(&dir)?;
        return Ok(dir);
    }
    Ok(paths::app_data_dir(&app.path().data_dir()?))
}

fn secret_store(data_dir: &std::path::Path) -> Arc<dyn connections::secrets::SecretStore> {
    #[cfg(feature = "e2e")]
    if testmode::active() {
        if testmode::real_keychain() {
            return Arc::new(connections::secrets::KeyringStore::with_service(
                testmode::KEYCHAIN_SERVICE,
            ));
        }
        return Arc::new(testmode::FileSecretStore::new(data_dir));
    }
    let _ = data_dir;
    Arc::new(connections::secrets::KeyringStore::default())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data_dir = resolve_data_dir(app)?;
            applog::init(&data_dir);
            let store = tauri::async_runtime::block_on(store::Store::open(&data_dir))?;
            let registry = Arc::new(drivers::registry::Registry::with_defaults());
            let host_key_prompts = Arc::new(transport::hostkey::PendingPrompts::default());
            let handle = app.handle().clone();
            let ssh_env = transport::ssh::SshEnv {
                known_hosts: transport::hostkey::KnownHosts::new(&data_dir),
                prompter: Arc::new(transport::hostkey::EventPrompter {
                    pending: host_key_prompts.clone(),
                    emit: Arc::new(move |prompt| {
                        let _ = handle.emit("host_key_prompt", prompt);
                    }),
                    timeout: Duration::from_secs(120),
                }),
            };
            let password_prompts = Arc::new(connections::service::PendingPasswords::default());
            let handle = app.handle().clone();
            let secrets = secret_store(&data_dir);
            let copilot = {
                let handle = app.handle().clone();
                ai::copilot::service::CopilotService::new(
                    data_dir.clone(),
                    Arc::new(move |state| {
                        let _ = handle.emit("copilot_state", state);
                    }),
                )
            };
            let (ai, ai_backup) = ai::AiService::new(data_dir.clone(), secrets.clone());
            if let Some(backup) = ai_backup {
                applog::log(&format!(
                    "ai.json was unreadable; moved to {}",
                    backup.display()
                ));
            }
            let (connections, loaded) = connections::service::ConnectionService::new(
                &data_dir,
                secrets,
                Arc::new(connections::service::EventPasswordPrompter {
                    pending: password_prompts.clone(),
                    emit: Arc::new(move |prompt| {
                        let _ = handle.emit("password_prompt", prompt);
                    }),
                    timeout: Duration::from_secs(120),
                }),
            );
            if let Some(backup) = loaded.backup {
                applog::log(&format!(
                    "connections.json was unreadable; moved to {}",
                    backup.display()
                ));
            }
            let palette = Arc::new(palette::Palette::with_entries(
                tauri::async_runtime::block_on(store.palette_load()).unwrap_or_default(),
            ));
            let sessions = Arc::new(sessions::SessionManager::new(registry.clone(), ssh_env));
            sessions.set_history_sink(history::sink(store.clone()));
            spawn_idle_sweeper(sessions.clone());
            let files = files::FileAccess::new(&data_dir, {
                let handle = app.handle().clone();
                Arc::new(move |path| {
                    let _ = handle.emit("file_changed", path);
                })
            });
            app.manage(state::AppState {
                data_dir,
                store,
                registry,
                sessions,
                host_key_prompts,
                connections: Arc::new(connections),
                password_prompts,
                test_cancels: Default::default(),
                files,
                exports: Default::default(),
                editability: Default::default(),
                palette,
                ai: Arc::new(ai),
                copilot: copilot.clone(),
            });
            // Pick up an existing Copilot sign-in without asking for anything.
            tauri::async_runtime::spawn(async move { copilot.refresh().await });
            if let Some(window) = app.get_webview_window("main") {
                correct_off_screen(&window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if commands::app::hold_quit(app) {
                    // An open transaction: the frontend asks Commit / Roll back / Cancel first.
                    api.prevent_close();
                    let _ = app.emit("quit-requested", ());
                    return;
                }
                let _ = app.save_window_state(StateFlags::all());
            }
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(feature = "e2e")]
            testmode::e2e_dialog_next,
            #[cfg(feature = "e2e")]
            testmode::e2e_now,
            #[cfg(feature = "e2e")]
            testmode::e2e_restart,
            #[cfg(feature = "e2e")]
            testmode::e2e_exit,
            #[cfg(feature = "e2e")]
            testmode::e2e_keychain_get,
            #[cfg(feature = "e2e")]
            testmode::e2e_keychain_delete,
            diagnostics::about_info,
            diagnostics::licenses_html,
            cli::installed_with_homebrew,
            diagnostics::diagnostics_bundle,
            commands::app::app_paths,
            commands::app::app_quit_confirmed,
            commands::app::oracle_client_status,
            commands::drivers::drivers_list,
            commands::sessions::connection_test,
            commands::sessions::connection_connect,
            commands::sessions::connection_disconnect,
            commands::sessions::session_open,
            commands::sessions::session_close,
            commands::sessions::sessions_subscribe,
            commands::sessions::sessions_list,
            commands::sessions::sessions_open_transactions,
            commands::sessions::session_set_meta,
            commands::sessions::session_attach,
            commands::sessions::session_detach,
            commands::sessions::session_commit,
            commands::sessions::session_rollback,
            commands::sessions::session_disconnect,
            commands::sessions::session_close_all,
            commands::sessions::session_set_isolation,
            commands::sessions::session_switch_namespace,
            commands::sessions::query_execute,
            commands::sessions::query_fetch_more,
            commands::sessions::query_cancel,
            commands::sessions::doc_call,
            commands::sessions::doc_safety_check,
            commands::sessions::kv_call,
            commands::graph::graph_query,
            commands::graph::graph_fetch_more,
            commands::graph::graph_expand,
            commands::graph::graph_schema,
            commands::graph::graph_databases,
            commands::graph::graph_update_properties,
            commands::graph::graph_update_safety_check,
            commands::sessions::value_fetch_full,
            commands::sessions::introspect_children,
            commands::sessions::completion_snapshot,
            commands::sessions::introspect_ddl,
            commands::sessions::explorer_count_rows,
            commands::sessions::table_meta,
            commands::sessions::table_query_sql,
            commands::sessions::changes_preview,
            commands::sessions::changes_apply,
            commands::results::results_resolve_edit,
            commands::results::changes_refetch,
            commands::sessions::safety_check,
            commands::sessions::safety_check_changes,
            commands::sessions::session_read_only,
            commands::sessions::session_set_read_only,
            commands::sessions::history_list,
            commands::palette::palette_search,
            commands::palette::palette_stats,
            commands::palette::palette_recent_queries,
            commands::palette::palette_clear,
            commands::ai::ai_settings_get,
            commands::ai::ai_settings_set,
            commands::ai::ai_secret_set,
            commands::ai::ai_secret_clear,
            commands::ai::ai_models,
            commands::ai::ai_test_provider,
            commands::ai::ai_policy,
            commands::ai::ai_chat,
            commands::ai::ai_cancel,
            commands::ai::ai_complete,
            commands::ai::ai_chats_list,
            commands::ai::ai_chat_load,
            commands::ai::ai_chat_save,
            commands::ai::ai_chats_delete,
            commands::external::open_external,
            commands::copilot::copilot_state,
            commands::copilot::copilot_refresh,
            commands::copilot::copilot_begin,
            commands::copilot::copilot_accept_consent,
            commands::copilot::copilot_decline_consent,
            commands::copilot::copilot_check_now,
            commands::copilot::copilot_cancel,
            commands::copilot::copilot_sign_out,
            commands::copilot::copilot_complete,
            commands::sessions::history_clear,
            commands::files::file_open_dialog,
            commands::files::file_save_dialog,
            commands::files::file_read,
            commands::files::file_write,
            commands::files::file_watch,
            commands::files::file_unwatch,
            commands::export::export_query,
            commands::export::export_cancel,
            commands::export::export_pick_path,
            commands::export::export_rows,
            commands::sessions::host_key_answer,
            commands::connections::connections_list,
            commands::connections::connections_save,
            commands::connections::connections_delete,
            commands::connections::connections_duplicate,
            commands::connections::groups_save,
            commands::connections::groups_delete,
            commands::connections::connection_secret_status,
            commands::connections::password_answer,
            commands::connections::connections_parse_url,
            commands::connections::connections_test,
            commands::connections::connections_test_cancel,
            commands::connections::connections_connect,
            commands::connections::connections_open_transactions,
            commands::connections::connections_disconnect,
            commands::connections::connection_deactivate,
            commands::connections::connections_export_summary,
            commands::connections::connections_export,
            commands::connections::import_datagrip_discover,
            commands::connections::import_datagrip_password_safe,
            commands::connections::import_clew_inspect,
            commands::connections::import_scan,
            commands::connections::import_commit,
            commands::connections::connections_scripts_info,
            commands::connections::connections_scripts_list,
            commands::connections::connections_scripts_new,
            commands::connections::connections_scripts_reveal,
            commands::connections::connections_rename,
            commands::connections::connections_finish_folder_rename,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::ui_state::ui_state_get,
            commands::ui_state::ui_state_set,
            commands::ui_state::ui_state_all,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Clew")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if commands::app::hold_quit(app) {
                    api.prevent_exit();
                    let _ = app.emit("quit-requested", ());
                }
            }
        });
}

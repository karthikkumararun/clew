use tauri::State;

use crate::drivers::registry::DriverGroup;
use crate::state::AppState;

/// Every registered driver with its metadata, grouped by family.
#[tauri::command]
pub fn drivers_list(state: State<'_, AppState>) -> Vec<DriverGroup> {
    state.registry.list_grouped()
}

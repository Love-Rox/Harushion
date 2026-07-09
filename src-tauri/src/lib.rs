mod github;

use github::{AppState, Item, Viewer};
use tauri::State;

#[tauri::command]
async fn get_viewer(state: State<'_, AppState>) -> Result<Viewer, String> {
    github::fetch_viewer(&state).await
}

#[tauri::command]
async fn fetch_items(state: State<'_, AppState>, query: Option<String>) -> Result<Vec<Item>, String> {
    let query = query.unwrap_or_else(|| "involves:@me sort:updated-desc".to_string());
    github::search_items(&state, &query, 50).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![get_viewer, fetch_items])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

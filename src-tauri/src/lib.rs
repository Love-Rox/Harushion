mod browser;
mod db;
mod gh;
mod github;
mod poller;

use db::{Db, StoredItem, Stream};
use gh::ItemAction;
use github::{AppState, ItemDetail, LabelInfo, Viewer};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
async fn get_viewer(state: State<'_, AppState>) -> Result<Viewer, String> {
    github::fetch_viewer(&state).await
}

#[tauri::command]
fn list_streams(db: State<'_, Db>) -> Result<Vec<Stream>, String> {
    db.list_streams()
}

#[tauri::command]
fn create_stream(
    db: State<'_, Db>,
    name: String,
    query: String,
    folder: Option<String>,
    interval_sec: i64,
) -> Result<Stream, String> {
    let id = db.create_stream(&name, &query, folder.as_deref(), interval_sec)?;
    db.get_stream(id)
}

#[tauri::command]
fn update_stream(
    db: State<'_, Db>,
    id: i64,
    name: String,
    query: String,
    folder: Option<String>,
    interval_sec: i64,
    enabled: bool,
) -> Result<Stream, String> {
    db.update_stream(id, &name, &query, folder.as_deref(), interval_sec, enabled)?;
    db.get_stream(id)
}

#[tauri::command]
fn delete_stream(db: State<'_, Db>, id: i64) -> Result<(), String> {
    db.delete_stream(id)
}

#[tauri::command]
fn list_items(db: State<'_, Db>, stream_id: i64, unread_only: bool) -> Result<Vec<StoredItem>, String> {
    db.list_items(stream_id, unread_only)
}

#[tauri::command]
fn mark_read(db: State<'_, Db>, item_url: String) -> Result<(), String> {
    db.mark_read(&item_url)
}

#[tauri::command]
fn mark_unread(db: State<'_, Db>, item_url: String) -> Result<(), String> {
    db.mark_unread(&item_url)
}

#[tauri::command]
fn mark_all_read(db: State<'_, Db>, stream_id: i64) -> Result<(), String> {
    db.mark_all_read(stream_id)
}

#[tauri::command]
async fn get_item_detail(state: State<'_, AppState>, url: String) -> Result<ItemDetail, String> {
    github::fetch_item_detail(&state, &url).await
}

#[tauri::command]
async fn item_action(url: String, kind: String, action: ItemAction) -> Result<String, String> {
    let invocation = gh::build_invocation(&url, &kind, &action)?;
    gh::run_gh(invocation).await
}

#[tauri::command]
async fn list_repo_labels(repo: String) -> Result<Vec<LabelInfo>, String> {
    gh::list_repo_labels(&repo).await
}

#[tauri::command]
async fn open_in_app_browser(app: AppHandle, url: String) -> Result<(), String> {
    browser::open_github(&app, &url).await
}

#[tauri::command]
async fn poll_stream_now(app: AppHandle, stream_id: i64) -> Result<usize, String> {
    let stream = app.state::<Db>().get_due_stream(stream_id)?;
    // 手動更新はユーザーが画面を見ているので OS 通知しない
    poller::poll_stream(&app, &stream, false).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Db::open(&data_dir.join("gitviewer.db"))
                .map_err(std::io::Error::other)?;
            app.manage(db);
            poller::spawn(app.handle().clone());

            // 起動スモーク用フック: ウィンドウ生成→navigate の実経路を CI 外で確認する
            if std::env::var("GITVIEWER_SMOKE_BROWSER").is_ok() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match browser::open_github(&handle, "https://github.com/Love-Rox/GitViewer").await {
                        Ok(()) => eprintln!("[smoke] browser window created"),
                        Err(e) => eprintln!("[smoke] browser create FAILED: {e}"),
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    match browser::open_github(&handle, "https://github.com/tauri-apps/tauri").await {
                        Ok(()) => eprintln!("[smoke] browser navigate ok"),
                        Err(e) => eprintln!("[smoke] browser navigate FAILED: {e}"),
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_viewer,
            list_streams,
            create_stream,
            update_stream,
            delete_stream,
            list_items,
            mark_read,
            mark_unread,
            mark_all_read,
            poll_stream_now,
            get_item_detail,
            item_action,
            list_repo_labels,
            open_in_app_browser
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

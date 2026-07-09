mod browser;
mod db;
mod gh;
mod github;
mod graph;
mod poller;
mod updater;

use db::{Db, StoredItem, Stream};
use gh::ItemAction;
use github::{AppState, ItemDetail, LabelInfo, Viewer};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
async fn get_viewer(state: State<'_, AppState>) -> Result<Viewer, String> {
    github::fetch_viewer(&state).await
}

#[tauri::command]
fn list_streams(db: State<'_, Db>) -> Result<Vec<Stream>, String> {
    db.list_streams()
}

/// 色は 6 桁 hex(# なし)のみ許可
fn validate_color(color: &Option<String>) -> Result<(), String> {
    match color {
        Some(c) if c.len() != 6 || !c.chars().all(|ch| ch.is_ascii_hexdigit()) => {
            Err(format!("不正な色指定です: {c}"))
        }
        _ => Ok(()),
    }
}

#[tauri::command]
fn create_stream(
    db: State<'_, Db>,
    name: String,
    query: String,
    folder: Option<String>,
    interval_sec: i64,
    color: Option<String>,
) -> Result<Stream, String> {
    validate_color(&color)?;
    let id = db.create_stream(&name, &query, folder.as_deref(), interval_sec, color.as_deref())?;
    db.get_stream(id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_stream(
    db: State<'_, Db>,
    id: i64,
    name: String,
    query: String,
    folder: Option<String>,
    interval_sec: i64,
    enabled: bool,
    color: Option<String>,
) -> Result<Stream, String> {
    validate_color(&color)?;
    db.update_stream(id, &name, &query, folder.as_deref(), interval_sec, enabled, color.as_deref())?;
    db.get_stream(id)
}

#[tauri::command]
fn list_folder_colors(db: State<'_, Db>) -> Result<std::collections::HashMap<String, String>, String> {
    db.list_folder_colors()
}

#[tauri::command]
fn reorder_streams(db: State<'_, Db>, ids: Vec<i64>) -> Result<Vec<Stream>, String> {
    db.reorder_streams(&ids)?;
    db.list_streams()
}

#[tauri::command]
fn list_folder_order(db: State<'_, Db>) -> Result<Vec<String>, String> {
    db.list_folder_order()
}

#[tauri::command]
fn reorder_folders(db: State<'_, Db>, folders: Vec<String>) -> Result<Vec<String>, String> {
    db.reorder_folders(&folders)?;
    db.list_folder_order()
}

#[tauri::command]
fn set_folder_color(
    db: State<'_, Db>,
    folder: String,
    color: Option<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    validate_color(&color)?;
    db.set_folder_color(&folder, color.as_deref())?;
    db.list_folder_colors()
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
async fn get_item_detail(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<ItemDetail, String> {
    let detail = github::fetch_item_detail(&state, &url).await?;
    // 詳細で判明した最新状態を DB に反映し、合致しなくなった Stream からリンクを掃除
    let pruned = app
        .state::<Db>()
        .refresh_item_state(&url, &detail.state, detail.is_draft)?;
    for stream_id in pruned {
        let _ = app.emit("items-updated", serde_json::json!({ "streamId": stream_id }));
    }
    Ok(detail)
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
async fn check_for_update(state: State<'_, AppState>) -> Result<Option<updater::UpdateInfo>, String> {
    updater::check_update(&state).await
}

#[tauri::command]
fn list_graph_repos(db: State<'_, Db>) -> Result<Vec<String>, String> {
    db.list_graph_repos()
}

#[tauri::command]
fn add_graph_repo(db: State<'_, Db>, repo: String) -> Result<Vec<String>, String> {
    graph::validate_repo(&repo)?;
    db.add_graph_repo(&repo)?;
    db.list_graph_repos()
}

#[tauri::command]
fn remove_graph_repo(db: State<'_, Db>, repo: String) -> Result<Vec<String>, String> {
    db.remove_graph_repo(&repo)?;
    db.list_graph_repos()
}

#[tauri::command]
async fn get_branch_graph(
    state: State<'_, AppState>,
    repo: String,
) -> Result<graph::BranchGraph, String> {
    graph::fetch_branch_graph(&state, &repo).await
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
            // 旧 identifier (com.love-rox.gitviewer) 時代のデータディレクトリからの移行
            if !data_dir.exists() {
                if let Some(parent) = data_dir.parent() {
                    let legacy_dir = parent.join("com.love-rox.gitviewer");
                    if legacy_dir.exists() {
                        let _ = std::fs::rename(&legacy_dir, &data_dir);
                    }
                }
            }
            std::fs::create_dir_all(&data_dir)?;

            // DB ファイル名も旧名 (gitviewer.db) から移行(WAL/SHM を含めて揃えて改名)
            let db_path = data_dir.join("harushion.db");
            if !db_path.exists() && data_dir.join("gitviewer.db").exists() {
                for suffix in ["", "-wal", "-shm"] {
                    let old = data_dir.join(format!("gitviewer.db{suffix}"));
                    if old.exists() {
                        let _ = std::fs::rename(&old, data_dir.join(format!("harushion.db{suffix}")));
                    }
                }
            }

            let db = Db::open(&db_path).map_err(std::io::Error::other)?;
            app.manage(db);
            poller::spawn(app.handle().clone());
            updater::spawn(app.handle().clone());

            // 起動スモーク用フック: ウィンドウ生成→navigate の実経路を CI 外で確認する
            if std::env::var("HARUSHION_SMOKE_BROWSER").is_ok() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match browser::open_github(&handle, "https://github.com/Love-Rox/Harushion").await {
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
            open_in_app_browser,
            list_graph_repos,
            add_graph_repo,
            remove_graph_repo,
            get_branch_graph,
            list_folder_colors,
            set_folder_color,
            reorder_streams,
            list_folder_order,
            reorder_folders,
            check_for_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

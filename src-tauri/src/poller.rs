use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::{Db, DueStream};
use crate::github::{self, AppState};

const TICK: Duration = Duration::from_secs(15);
/// 1 回のポーリングで取得する検索結果の上限(50件/ページでページング)。
/// レート消費と表示上限(500件)のバランスで 200 に設定。
const MAX_FETCH: u32 = 200;

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = tick(&app).await {
                eprintln!("[poller] {e}");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

async fn tick(app: &AppHandle) -> Result<(), String> {
    let due = app.state::<Db>().due_streams(unix_now())?;
    for stream in due {
        // 1 Stream の失敗(オフライン等)で他を止めない
        if let Err(e) = poll_stream(app, &stream, true).await {
            eprintln!("[poller] stream {} ({}): {e}", stream.id, stream.name);
        }
    }
    Ok(())
}

/// Stream を 1 回ポーリングして新着数を返す。notify=true なら新着を OS 通知する
/// (初回ポーリングはバックフィルなので通知しない)。
pub async fn poll_stream(app: &AppHandle, stream: &DueStream, notify: bool) -> Result<usize, String> {
    // query は改行区切りで複数の検索クエリを持てる(結果を OR マージ、URL で重複排除)
    let items = {
        let gh = app.state::<AppState>();
        let mut all = Vec::new();
        for line in stream.query.lines().map(str::trim).filter(|l| !l.is_empty()) {
            all.extend(github::search_items(&gh, line, MAX_FETCH).await?);
        }
        all
    };

    let db = app.state::<Db>();
    let fresh = db.upsert_items(stream.id, &items)?;
    // マージ済み・クローズ済み等、クエリに確実に合致しなくなったアイテムのリンクを掃除
    let pruned = db.prune_stream_links(stream.id, &stream.query)?;
    db.set_polled(stream.id, unix_now())?;

    if !fresh.is_empty() || pruned > 0 {
        let _ = app.emit("items-updated", serde_json::json!({ "streamId": stream.id }));

        if notify && !stream.first_poll && !fresh.is_empty() {
            let body = match fresh.len() {
                1 => fresh[0].clone(),
                n => format!("{} 他{}件", fresh[0], n - 1),
            };
            let builder = app
                .notification()
                .builder()
                .title(format!("{} に新着 {} 件", stream.name, fresh.len()))
                .body(body);
            // macOS/Windows はバンドルのアプリアイコンが自動適用される。
            // Linux (freedesktop) のみ、パッケージが導入するアイコン名を明示する。
            #[cfg(target_os = "linux")]
            let builder = builder.icon("harushion".to_string());
            if let Err(e) = builder.show() {
                eprintln!("[poller] notification failed: {e}");
            }
        }
    }
    Ok(fresh.len())
}

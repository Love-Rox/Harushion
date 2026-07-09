use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::github::AppState;

const RELEASES_REPO: &str = "Love-Rox/Harushion";
/// 起動直後の初回チェックまでの待ち(gh 認証や初回ポーリングと競合しないよう少し遅らせる)
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60 * 24);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub url: String,
}

/// "1.2.3" 形式を比較。パースできない部分は 0 扱い。
fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (l, c) = (parse(latest), parse(current));
    for i in 0..l.len().max(c.len()) {
        let (a, b) = (l.get(i).copied().unwrap_or(0), c.get(i).copied().unwrap_or(0));
        if a != b {
            return a > b;
        }
    }
    false
}

/// 最新リリースを確認し、現行より新しければ UpdateInfo を返す。
/// リリースが存在しない(404)場合は None。
pub async fn check_update(state: &AppState) -> Result<Option<UpdateInfo>, String> {
    let data = match state.rest_get(&format!("repos/{RELEASES_REPO}/releases/latest")).await {
        Ok(data) => data,
        Err(e) if e.contains("404") => return Ok(None),
        Err(e) => return Err(e),
    };
    let latest = data["tag_name"]
        .as_str()
        .unwrap_or_default()
        .trim_start_matches('v')
        .to_string();
    let current = env!("CARGO_PKG_VERSION").to_string();
    if latest.is_empty() || !version_newer(&latest, &current) {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        current,
        latest,
        url: data["html_url"]
            .as_str()
            .unwrap_or("https://github.com/Love-Rox/Harushion/releases")
            .to_string(),
    }))
}

/// 起動 20 秒後と、その後 24 時間ごとに更新チェックし、新版があればイベントで通知する。
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let state = app.state::<AppState>();
            match check_update(&state).await {
                Ok(Some(info)) => {
                    let _ = app.emit("update-available", &info);
                }
                Ok(None) => {}
                Err(e) => eprintln!("[updater] {e}"),
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison() {
        assert!(version_newer("0.2.0", "0.1.0"));
        assert!(version_newer("1.0.0", "0.9.9"));
        assert!(version_newer("0.1.10", "0.1.9"));
        assert!(!version_newer("0.1.0", "0.1.0"));
        assert!(!version_newer("0.1.0", "0.2.0"));
        // 数字以外の接尾辞は無視して比較
        assert!(version_newer("0.2.0-beta", "0.1.0"));
    }
}

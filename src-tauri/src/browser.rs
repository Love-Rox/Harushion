use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const BROWSER_LABEL: &str = "github-browser";

/// アプリ内ブラウザで開くのは github.com (https) のみ。
/// このウィンドウは capability に含めないため、リモートコンテンツから IPC は呼べない。
pub fn validate_github_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| format!("URL を解釈できません: {e}"))?;
    // port() は既定ポート(443)なら None。非標準ポート指定は拒否する
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") || parsed.port().is_some() {
        return Err("アプリ内ブラウザで開けるのは https://github.com のページのみです".into());
    }
    Ok(parsed)
}

pub async fn open_github(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = validate_github_url(url)?;

    if let Some(window) = app.get_webview_window(BROWSER_LABEL) {
        window
            .navigate(parsed)
            .map_err(|e| format!("ページ遷移に失敗しました: {e}"))?;
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(app, BROWSER_LABEL, WebviewUrl::External(parsed))
        .title("GitHub — GitViewer")
        .inner_size(1180.0, 860.0)
        .build()
        .map_err(|e| format!("ブラウザウィンドウを開けませんでした: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_https_github_com() {
        assert!(validate_github_url("https://github.com/Love-Rox/GitViewer/issues/1").is_ok());
        assert!(validate_github_url("https://github.com/").is_ok());

        // ホスト偽装・スキーム違い・サブドメインは拒否
        assert!(validate_github_url("https://github.com.evil.example/x").is_err());
        assert!(validate_github_url("https://evil.example/github.com/").is_err());
        assert!(validate_github_url("http://github.com/foo").is_err());
        assert!(validate_github_url("https://gist.github.com/foo").is_err());
        assert!(validate_github_url("https://github.com:8443/foo").is_err());
        // 明示 :443 は WHATWG 正規化で既定ポート扱いになるので許可される
        assert!(validate_github_url("https://github.com:443/foo").is_ok());
        assert!(validate_github_url("file:///etc/passwd").is_err());
        assert!(validate_github_url("not a url").is_err());
    }
}

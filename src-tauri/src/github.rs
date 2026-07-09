use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

const GRAPHQL_ENDPOINT: &str = "https://api.github.com/graphql";
const USER_AGENT: &str = concat!("GitViewer/", env!("CARGO_PKG_VERSION"));

/// アプリ全体で共有する状態。トークンは gh CLI から取得しメモリ上にのみ保持する。
pub struct AppState {
    http: reqwest::Client,
    token: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
            token: Mutex::new(None),
        }
    }

    async fn token(&self) -> Result<String, String> {
        let mut guard = self.token.lock().await;
        if let Some(token) = guard.as_ref() {
            return Ok(token.clone());
        }
        let token = fetch_gh_token().await?;
        *guard = Some(token.clone());
        Ok(token)
    }

    async fn invalidate_token(&self) {
        *self.token.lock().await = None;
    }

    pub async fn graphql(&self, query: &str, variables: Value) -> Result<Value, String> {
        // 401 でトークンを破棄して一度だけ再取得する(gh 側で再ログインされた場合に追従)
        for attempt in 0..2 {
            let token = self.token().await?;
            let resp = self
                .http
                .post(GRAPHQL_ENDPOINT)
                .bearer_auth(&token)
                .header("User-Agent", USER_AGENT)
                .json(&json!({ "query": query, "variables": variables }))
                .send()
                .await
                .map_err(|e| format!("GitHub API への接続に失敗しました: {e}"))?;

            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                self.invalidate_token().await;
                continue;
            }

            let body: Value = resp
                .json()
                .await
                .map_err(|e| format!("GitHub API のレスポンスを解釈できませんでした: {e}"))?;

            if !status.is_success() {
                let message = body["message"].as_str().unwrap_or("unknown error");
                return Err(format!("GitHub API エラー ({status}): {message}"));
            }
            if let Some(errors) = body.get("errors").and_then(Value::as_array) {
                let messages: Vec<&str> = errors
                    .iter()
                    .filter_map(|e| e["message"].as_str())
                    .collect();
                return Err(format!("GraphQL エラー: {}", messages.join(" / ")));
            }
            return Ok(body["data"].clone());
        }
        unreachable!("graphql retry loop always returns")
    }
}

/// `gh auth token` を実行してトークンを取得する。ディスクには保存しない。
async fn fetch_gh_token() -> Result<String, String> {
    let output = tokio::process::Command::new("gh")
        .args(["auth", "token"])
        .output()
        .await
        .map_err(|e| {
            format!("gh コマンドを実行できませんでした ({e})。GitHub CLI をインストールしてください: https://cli.github.com")
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "gh の認証情報を取得できませんでした。`gh auth login` でログインしてください。({})",
            stderr.trim()
        ));
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err("gh からトークンを取得できませんでした。`gh auth login` でログインしてください。".into());
    }
    Ok(token)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub kind: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub updated_at: String,
    pub author: Option<String>,
    pub author_avatar: Option<String>,
    pub repo: String,
    pub comments: i64,
}

pub async fn fetch_viewer(state: &AppState) -> Result<Viewer, String> {
    let data = state
        .graphql("query { viewer { login avatarUrl } }", json!({}))
        .await?;
    Ok(Viewer {
        login: data["viewer"]["login"].as_str().unwrap_or_default().to_string(),
        avatar_url: data["viewer"]["avatarUrl"].as_str().unwrap_or_default().to_string(),
    })
}

const SEARCH_QUERY: &str = r#"
query($q: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) {
    nodes {
      __typename
      ... on Issue {
        number title url state updatedAt
        author { login avatarUrl }
        repository { nameWithOwner }
        comments { totalCount }
      }
      ... on PullRequest {
        number title url state isDraft updatedAt
        author { login avatarUrl }
        repository { nameWithOwner }
        comments { totalCount }
      }
    }
  }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    // gh の実認証とネットワークを使う統合テスト。`cargo test -- --ignored` で明示実行する。
    #[tokio::test]
    #[ignore = "requires gh auth and network"]
    async fn fetches_viewer_and_items_via_real_gh_auth() {
        let state = AppState::new();

        let viewer = fetch_viewer(&state).await.expect("viewer fetch failed");
        assert!(!viewer.login.is_empty(), "viewer login should not be empty");

        let items = search_items(&state, "involves:@me sort:updated-desc", 10)
            .await
            .expect("search failed");
        for item in &items {
            assert!(!item.title.is_empty());
            assert!(item.url.starts_with("https://"));
            assert!(matches!(item.kind.as_str(), "issue" | "pr"));
        }
    }
}

pub async fn search_items(state: &AppState, query: &str, first: u32) -> Result<Vec<Item>, String> {
    let data = state
        .graphql(SEARCH_QUERY, json!({ "q": query, "first": first }))
        .await?;

    let nodes = data["search"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let items = nodes
        .iter()
        .filter_map(|node| {
            let kind = match node["__typename"].as_str()? {
                "Issue" => "issue",
                "PullRequest" => "pr",
                _ => return None,
            };
            Some(Item {
                kind: kind.to_string(),
                number: node["number"].as_i64()?,
                title: node["title"].as_str()?.to_string(),
                url: node["url"].as_str()?.to_string(),
                state: node["state"].as_str().unwrap_or_default().to_string(),
                is_draft: node["isDraft"].as_bool().unwrap_or(false),
                updated_at: node["updatedAt"].as_str().unwrap_or_default().to_string(),
                author: node["author"]["login"].as_str().map(String::from),
                author_avatar: node["author"]["avatarUrl"].as_str().map(String::from),
                repo: node["repository"]["nameWithOwner"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                comments: node["comments"]["totalCount"].as_i64().unwrap_or(0),
            })
        })
        .collect();

    Ok(items)
}

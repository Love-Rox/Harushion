use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

const GRAPHQL_ENDPOINT: &str = "https://api.github.com/graphql";
const USER_AGENT: &str = concat!("Harushion/", env!("CARGO_PKG_VERSION"));

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

    /// GitHub REST API への GET(更新チェック等の GraphQL 非対応エンドポイント用)
    pub async fn rest_get(&self, path: &str) -> Result<Value, String> {
        let token = self.token().await?;
        let resp = self
            .http
            .get(format!("https://api.github.com/{path}"))
            .bearer_auth(&token)
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("GitHub API への接続に失敗しました: {e}"))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("GitHub API のレスポンスを解釈できませんでした: {e}"))?;
        if !status.is_success() {
            let message = body["message"].as_str().unwrap_or("unknown error");
            return Err(format!("GitHub API エラー ({status}): {message}"));
        }
        Ok(body)
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
    pub milestone: Option<String>,
    pub assignees: Vec<String>,
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
query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue {
        number title url state updatedAt
        author { login avatarUrl }
        repository { nameWithOwner }
        comments { totalCount }
        milestone { title }
        assignees(first: 10) { nodes { login } }
      }
      ... on PullRequest {
        number title url state isDraft updatedAt
        author { login avatarUrl }
        repository { nameWithOwner }
        comments { totalCount }
        milestone { title }
        assignees(first: 10) { nodes { login } }
      }
    }
  }
}
"#;

const SEARCH_PAGE_SIZE: u32 = 50;

/// 検索結果をカーソルでページングしながら最大 max_total 件まで取得する。
pub async fn search_items(state: &AppState, query: &str, max_total: u32) -> Result<Vec<Item>, String> {
    let mut items: Vec<Item> = Vec::new();
    let mut after: Option<String> = None;

    loop {
        let remaining = max_total.saturating_sub(items.len() as u32);
        if remaining == 0 {
            break;
        }
        let data = state
            .graphql(
                SEARCH_QUERY,
                json!({ "q": query, "first": SEARCH_PAGE_SIZE.min(remaining), "after": after }),
            )
            .await?;

        let nodes = data["search"]["nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        items.extend(nodes.iter().filter_map(|node| {
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
                milestone: node["milestone"]["title"].as_str().map(String::from),
                assignees: node["assignees"]["nodes"]
                    .as_array()
                    .map(|ns| ns.iter().filter_map(|n| n["login"].as_str().map(String::from)).collect())
                    .unwrap_or_default(),
            })
        }));

        let page_info = &data["search"]["pageInfo"];
        if !page_info["hasNextPage"].as_bool().unwrap_or(false) {
            break;
        }
        after = page_info["endCursor"].as_str().map(String::from);
        if after.is_none() {
            break;
        }
    }

    Ok(items)
}

/// エピック内アイテムの最新状態(バッチ取得用)
pub struct ItemStatus {
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub title: String,
    pub milestone: Option<String>,
}

/// URL 群の現在状態をエイリアス付き GraphQL でまとめて取得する(40件/リクエスト)。
pub async fn fetch_item_states(state: &AppState, urls: &[String]) -> Result<Vec<ItemStatus>, String> {
    let mut results = Vec::with_capacity(urls.len());
    for chunk in urls.chunks(40) {
        let mut vars_decl = Vec::new();
        let mut fields = Vec::new();
        let mut variables = serde_json::Map::new();
        for (i, url) in chunk.iter().enumerate() {
            vars_decl.push(format!("$u{i}: URI!"));
            fields.push(format!(
                "i{i}: resource(url: $u{i}) {{ __typename \
                 ... on Issue {{ url state title milestone {{ title }} }} \
                 ... on PullRequest {{ url state isDraft title milestone {{ title }} }} }}"
            ));
            variables.insert(format!("u{i}"), Value::String(url.clone()));
        }
        let query = format!("query({}) {{ {} }}", vars_decl.join(", "), fields.join(" "));
        let data = state.graphql(&query, Value::Object(variables)).await?;
        for i in 0..chunk.len() {
            let node = &data[format!("i{i}")];
            let Some(url) = node["url"].as_str() else { continue };
            results.push(ItemStatus {
                url: url.to_string(),
                state: node["state"].as_str().unwrap_or_default().to_string(),
                is_draft: node["isDraft"].as_bool().unwrap_or(false),
                title: node["title"].as_str().unwrap_or_default().to_string(),
                milestone: node["milestone"]["title"].as_str().map(String::from),
            });
        }
    }
    Ok(results)
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LabelInfo {
    pub name: String,
    pub color: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentInfo {
    pub author: Option<String>,
    pub author_avatar: Option<String>,
    pub body_html: String,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInfo {
    pub name: String,
    pub status: String,
    pub url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInfo {
    pub author: Option<String>,
    pub state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedItem {
    pub kind: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub repo: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetail {
    pub kind: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub body_html: String,
    pub created_at: String,
    pub updated_at: String,
    pub author: Option<String>,
    pub author_avatar: Option<String>,
    pub repo: String,
    pub labels: Vec<LabelInfo>,
    pub assignees: Vec<String>,
    pub milestone: Option<String>,
    pub base_ref: Option<String>,
    pub head_ref: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    pub mergeable: Option<String>,
    pub review_decision: Option<String>,
    pub checks: Vec<CheckInfo>,
    pub reviews: Vec<ReviewInfo>,
    pub comments: Vec<CommentInfo>,
    pub comments_total: i64,
    pub related: Vec<RelatedItem>,
    pub related_total: i64,
}

const DETAIL_QUERY: &str = r#"
query($url: URI!) {
  resource(url: $url) {
    __typename
    ... on Issue {
      number title url state bodyHTML createdAt updatedAt
      author { login avatarUrl }
      repository { nameWithOwner }
      labels(first: 30) { nodes { name color } }
      assignees(first: 15) { nodes { login } }
      milestone { title }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
        totalCount
        nodes { number title url state isDraft repository { nameWithOwner } }
      }
      comments(last: 30) {
        totalCount
        nodes { author { login avatarUrl } bodyHTML createdAt }
      }
    }
    ... on PullRequest {
      number title url state isDraft bodyHTML createdAt updatedAt
      author { login avatarUrl }
      repository { nameWithOwner }
      labels(first: 30) { nodes { name color } }
      assignees(first: 15) { nodes { login } }
      milestone { title }
      baseRefName headRefName additions deletions changedFiles
      mergeable reviewDecision
      closingIssuesReferences(first: 10) {
        totalCount
        nodes { number title url state repository { nameWithOwner } }
      }
      latestReviews(first: 15) { nodes { author { login } state } }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 50) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
      comments(last: 30) {
        totalCount
        nodes { author { login avatarUrl } bodyHTML createdAt }
      }
    }
  }
}
"#;

fn parse_comments(node: &Value) -> (Vec<CommentInfo>, i64) {
    let total = node["comments"]["totalCount"].as_i64().unwrap_or(0);
    let comments = node["comments"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|c| {
                    Some(CommentInfo {
                        author: c["author"]["login"].as_str().map(String::from),
                        author_avatar: c["author"]["avatarUrl"].as_str().map(String::from),
                        body_html: c["bodyHTML"].as_str()?.to_string(),
                        created_at: c["createdAt"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (comments, total)
}

fn parse_checks(node: &Value) -> Vec<CheckInfo> {
    node["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|c| match c["__typename"].as_str()? {
                    "CheckRun" => Some(CheckInfo {
                        name: c["name"].as_str()?.to_string(),
                        // 完了済みなら結論(SUCCESS/FAILURE等)、実行中ならステータス(IN_PROGRESS等)
                        status: c["conclusion"]
                            .as_str()
                            .or(c["status"].as_str())
                            .unwrap_or("PENDING")
                            .to_string(),
                        url: c["detailsUrl"].as_str().map(String::from),
                    }),
                    "StatusContext" => Some(CheckInfo {
                        name: c["context"].as_str()?.to_string(),
                        status: c["state"].as_str().unwrap_or("PENDING").to_string(),
                        url: c["targetUrl"].as_str().map(String::from),
                    }),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Development リンク(Issue⇔PR)。Issue 側は「この Issue を閉じる PR」、
/// PR 側は「この PR が閉じる Issue」で、向きによってフィールド名と相手の kind が変わる
fn parse_related(node: &Value, kind: &str) -> (Vec<RelatedItem>, i64) {
    let (key, related_kind) = if kind == "issue" {
        ("closedByPullRequestsReferences", "pr")
    } else {
        ("closingIssuesReferences", "issue")
    };
    let total = node[key]["totalCount"].as_i64().unwrap_or(0);
    let related = node[key]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| {
                    Some(RelatedItem {
                        kind: related_kind.to_string(),
                        number: n["number"].as_i64()?,
                        title: n["title"].as_str()?.to_string(),
                        url: n["url"].as_str()?.to_string(),
                        state: n["state"].as_str().unwrap_or_default().to_string(),
                        is_draft: n["isDraft"].as_bool().unwrap_or(false),
                        repo: n["repository"]["nameWithOwner"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (related, total)
}

pub async fn fetch_item_detail(state: &AppState, url: &str) -> Result<ItemDetail, String> {
    let data = state.graphql(DETAIL_QUERY, json!({ "url": url })).await?;
    let node = &data["resource"];

    let kind = match node["__typename"].as_str() {
        Some("Issue") => "issue",
        Some("PullRequest") => "pr",
        _ => return Err("この URL は Issue / Pull Request ではありません".into()),
    };

    let names = |key: &str, field: &str| -> Vec<String> {
        node[key]["nodes"]
            .as_array()
            .map(|ns| {
                ns.iter()
                    .filter_map(|n| n[field].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };

    let labels = node["labels"]["nodes"]
        .as_array()
        .map(|ns| {
            ns.iter()
                .filter_map(|n| {
                    Some(LabelInfo {
                        name: n["name"].as_str()?.to_string(),
                        color: n["color"].as_str().unwrap_or("888888").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let reviews = node["latestReviews"]["nodes"]
        .as_array()
        .map(|ns| {
            ns.iter()
                .filter_map(|n| {
                    Some(ReviewInfo {
                        author: n["author"]["login"].as_str().map(String::from),
                        state: n["state"].as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let (comments, comments_total) = parse_comments(node);
    let (related, related_total) = parse_related(node, kind);

    Ok(ItemDetail {
        kind: kind.to_string(),
        number: node["number"].as_i64().unwrap_or(0),
        title: node["title"].as_str().unwrap_or_default().to_string(),
        url: node["url"].as_str().unwrap_or(url).to_string(),
        state: node["state"].as_str().unwrap_or_default().to_string(),
        is_draft: node["isDraft"].as_bool().unwrap_or(false),
        body_html: node["bodyHTML"].as_str().unwrap_or_default().to_string(),
        created_at: node["createdAt"].as_str().unwrap_or_default().to_string(),
        updated_at: node["updatedAt"].as_str().unwrap_or_default().to_string(),
        author: node["author"]["login"].as_str().map(String::from),
        author_avatar: node["author"]["avatarUrl"].as_str().map(String::from),
        repo: node["repository"]["nameWithOwner"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        labels,
        assignees: names("assignees", "login"),
        milestone: node["milestone"]["title"].as_str().map(String::from),
        base_ref: node["baseRefName"].as_str().map(String::from),
        head_ref: node["headRefName"].as_str().map(String::from),
        additions: node["additions"].as_i64().unwrap_or(0),
        deletions: node["deletions"].as_i64().unwrap_or(0),
        changed_files: node["changedFiles"].as_i64().unwrap_or(0),
        mergeable: node["mergeable"].as_str().map(String::from),
        review_decision: node["reviewDecision"].as_str().map(String::from),
        checks: parse_checks(node),
        reviews,
        comments,
        comments_total,
        related,
        related_total,
    })
}

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

    #[tokio::test]
    #[ignore = "requires gh auth and network"]
    async fn paginates_search_beyond_one_page() {
        let state = AppState::new();
        let items = search_items(&state, "repo:tauri-apps/tauri is:issue is:open sort:updated-desc", 120)
            .await
            .expect("search failed");
        assert_eq!(items.len(), 120, "should fetch past the 50-item first page");
        let unique: std::collections::HashSet<&str> = items.iter().map(|i| i.url.as_str()).collect();
        assert_eq!(unique.len(), items.len(), "pages must not overlap");
    }

    #[tokio::test]
    #[ignore = "requires gh auth and network"]
    async fn fetches_item_states_in_batch() {
        let state = AppState::new();
        let urls = vec![
            "https://github.com/tauri-apps/tauri/issues/2975".to_string(),
            "https://github.com/tauri-apps/tauri/pull/11000".to_string(),
        ];
        let states = fetch_item_states(&state, &urls).await.expect("batch fetch failed");
        assert_eq!(states.len(), 2);
        let pr = states.iter().find(|s| s.url.ends_with("/11000")).unwrap();
        assert_eq!(pr.state, "MERGED");
        assert!(!pr.title.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires gh auth and network"]
    async fn fetches_issue_detail_from_public_repo() {
        let state = AppState::new();
        let detail = fetch_item_detail(&state, "https://github.com/tauri-apps/tauri/issues/2975")
            .await
            .expect("detail fetch failed");
        assert_eq!(detail.kind, "issue");
        assert_eq!(detail.number, 2975);
        assert_eq!(detail.repo, "tauri-apps/tauri");
        assert!(!detail.title.is_empty());
        assert!(!detail.body_html.is_empty());
        assert!(detail.comments_total > 0);
        assert!(!detail.comments.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires gh auth and network"]
    async fn fetches_related_links_between_issue_and_pr() {
        let state = AppState::new();
        // Development リンクを持つ既知のペア(マージ済み PR とそれが閉じた Issue)
        let pr = fetch_item_detail(&state, "https://github.com/tauri-apps/tauri/pull/15677")
            .await
            .expect("pr detail fetch failed");
        assert!(
            pr.related.iter().any(|r| r.kind == "issue" && r.number == 15672),
            "PR 側に閉じた Issue が出るはず: {:?}",
            pr.related.iter().map(|r| r.number).collect::<Vec<_>>()
        );
        let issue = fetch_item_detail(&state, "https://github.com/tauri-apps/tauri/issues/15672")
            .await
            .expect("issue detail fetch failed");
        assert!(
            issue.related.iter().any(|r| r.kind == "pr" && r.number == 15677),
            "Issue 側に閉じる PR が出るはず: {:?}",
            issue.related.iter().map(|r| r.number).collect::<Vec<_>>()
        );
        assert!(issue.related_total >= 1);
    }

    #[tokio::test]
    #[ignore = "requires gh auth and network"]
    async fn fetches_pr_detail_with_pr_fields() {
        let state = AppState::new();
        // マージ済みの安定した公開 PR
        let detail = fetch_item_detail(&state, "https://github.com/tauri-apps/tauri/pull/11000")
            .await
            .expect("detail fetch failed");
        assert_eq!(detail.kind, "pr");
        assert_eq!(detail.state, "MERGED");
        assert!(detail.base_ref.is_some());
        assert!(detail.head_ref.is_some());
        assert!(detail.changed_files > 0);
    }
}


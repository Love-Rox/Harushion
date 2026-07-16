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
    pub review_requests: Vec<String>,
    pub related_count: i64,
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
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT]) { totalCount }
        closedByPullRequestsReferences { totalCount }
      }
      ... on PullRequest {
        number title url state isDraft updatedAt
        author { login avatarUrl }
        repository { nameWithOwner }
        comments { totalCount }
        milestone { title }
        assignees(first: 10) { nodes { login } }
        reviewRequests(first: 15) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Bot { login }
              ... on Mannequin { login }
              ... on Team { combinedSlug }
            }
          }
        }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT]) { totalCount }
        closingIssuesReferences { totalCount }
      }
    }
  }
}
"#;

const SEARCH_PAGE_SIZE: u32 = 50;

/// reviewRequests ノードからレビュー依頼中の相手を取り出す。
/// User/Bot/Mannequin は login、Team は "org/team-slug"
fn parse_review_requests(node: &Value) -> Vec<String> {
    node["reviewRequests"]["nodes"]
        .as_array()
        .map(|ns| {
            ns.iter()
                .filter_map(|n| {
                    let r = &n["requestedReviewer"];
                    r["login"]
                        .as_str()
                        .or_else(|| r["combinedSlug"].as_str())
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default()
}

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
                review_requests: parse_review_requests(node),
                related_count: node["timelineItems"]["totalCount"].as_i64().unwrap_or(0)
                    + node["closedByPullRequestsReferences"]["totalCount"].as_i64().unwrap_or(0)
                    + node["closingIssuesReferences"]["totalCount"].as_i64().unwrap_or(0),
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
pub struct ProjectStatusOption {
    pub id: String,
    pub name: String,
}

/// アイテムが所属する Project (v2) 1件分。ID 群は gh project item-edit にそのまま渡せる node ID
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItemInfo {
    pub item_id: String,
    pub project_id: String,
    pub title: String,
    pub number: i64,
    pub url: String,
    pub status: Option<String>,
    pub status_option_id: Option<String>,
    pub status_field_id: Option<String>,
    pub status_options: Vec<ProjectStatusOption>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub short_oid: String,
    pub message: String,
    pub author: Option<String>,
    pub author_avatar: Option<String>,
    pub date: String,
    pub url: String,
}

/// コメントとコミットを時系列で混ぜたタイムラインの1エントリ(GitHub の Conversation 相当)。
/// Issue のタイムラインに混ぜる「紐づいた PR」(クロスリファレンス)。
/// actor はリンク(言及)した人の login
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPrInfo {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub repo: String,
    pub actor: Option<String>,
    pub created_at: String,
}

/// kind タグ付きでフラットに serialize される({"kind":"comment", ...CommentInfo})
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TimelineEntry {
    Comment(CommentInfo),
    Commit(CommitInfo),
    LinkedPr(LinkedPrInfo),
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
    pub review_requests: Vec<String>,
    pub timeline: Vec<TimelineEntry>,
    pub timeline_total: i64,
    pub projects: Vec<ProjectItemInfo>,
    pub projects_scope_missing: bool,
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
      timelineItems(last: 20, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            createdAt
            actor { login }
            source {
              __typename
              ... on Issue { number title url state repository { nameWithOwner } }
              ... on PullRequest { number title url state isDraft repository { nameWithOwner } }
            }
          }
        }
      }
      timeline: timelineItems(last: 30, itemTypes: [ISSUE_COMMENT]) {
        totalCount
        nodes {
          __typename
          ... on IssueComment { author { login avatarUrl } bodyHTML createdAt }
        }
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
      timelineItems(last: 20, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on Issue { number title url state repository { nameWithOwner } }
              ... on PullRequest { number title url state isDraft repository { nameWithOwner } }
            }
          }
        }
      }
      latestReviews(first: 15) { nodes { author { login } state } }
      reviewRequests(first: 15) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login }
            ... on Bot { login }
            ... on Mannequin { login }
            ... on Team { combinedSlug }
          }
        }
      }
      timeline: timelineItems(last: 40, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_COMMIT]) {
        totalCount
        nodes {
          __typename
          ... on IssueComment { author { login avatarUrl } bodyHTML createdAt }
          ... on PullRequestCommit {
            commit {
              abbreviatedOid messageHeadline committedDate url
              author { name avatarUrl user { login } }
            }
          }
        }
      }
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
    }
  }
}
"#;

/// コメント+コミット(PR のみ)の統合タイムライン。
/// timelineItems は last:N の時系列順で返るので、そのまま古い→新しい順で表示できる
fn parse_timeline(node: &Value) -> (Vec<TimelineEntry>, i64) {
    let total = node["timeline"]["totalCount"].as_i64().unwrap_or(0);
    let entries = node["timeline"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| match n["__typename"].as_str()? {
                    "IssueComment" => Some(TimelineEntry::Comment(CommentInfo {
                        author: n["author"]["login"].as_str().map(String::from),
                        author_avatar: n["author"]["avatarUrl"].as_str().map(String::from),
                        body_html: n["bodyHTML"].as_str()?.to_string(),
                        created_at: n["createdAt"].as_str().unwrap_or_default().to_string(),
                    })),
                    "PullRequestCommit" => {
                        let c = &n["commit"];
                        Some(TimelineEntry::Commit(CommitInfo {
                            short_oid: c["abbreviatedOid"].as_str()?.to_string(),
                            message: c["messageHeadline"].as_str().unwrap_or_default().to_string(),
                            author: c["author"]["user"]["login"]
                                .as_str()
                                .or(c["author"]["name"].as_str())
                                .map(String::from),
                            author_avatar: c["author"]["avatarUrl"].as_str().map(String::from),
                            date: c["committedDate"].as_str().unwrap_or_default().to_string(),
                            url: c["url"].as_str().unwrap_or_default().to_string(),
                        }))
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    (entries, total)
}

/// Issue のタイムライン。コメント専用の timeline に、相互参照クエリから拾った
/// 「紐づいた PR」(PR 起点の言及)を時系列で合流させる。
/// timeline 側に CROSS_REFERENCED_EVENT を含めると、Issue 起点の言及ノイズが
/// last:30 の取得枠と totalCount を消費し、「他{n}件」の表示が実際に見える件数と
/// 食い違うため分離している。total には合流させた LinkedPr の件数を足し、
/// 差分がそのまま「隠れている古いコメント数」になるようにする
fn parse_issue_timeline(node: &Value) -> (Vec<TimelineEntry>, i64) {
    let (mut entries, mut total) = parse_timeline(node);
    let linked: Vec<TimelineEntry> = node["timelineItems"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| {
                    let s = &n["source"];
                    if s["__typename"].as_str()? != "PullRequest" {
                        return None;
                    }
                    Some(TimelineEntry::LinkedPr(LinkedPrInfo {
                        number: s["number"].as_i64()?,
                        title: s["title"].as_str().unwrap_or_default().to_string(),
                        url: s["url"].as_str()?.to_string(),
                        state: s["state"].as_str().unwrap_or_default().to_string(),
                        is_draft: s["isDraft"].as_bool().unwrap_or(false),
                        repo: s["repository"]["nameWithOwner"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                        actor: n["actor"]["login"].as_str().map(String::from),
                        created_at: n["createdAt"].as_str().unwrap_or_default().to_string(),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    total += linked.len() as i64;
    entries.extend(linked);
    // ISO 8601 (UTC) は文字列比較で時系列になる。sort_by は安定なので同時刻は元の順
    entries.sort_by(|a, b| entry_created_at(a).cmp(entry_created_at(b)));
    (entries, total)
}

fn entry_created_at(e: &TimelineEntry) -> &str {
    match e {
        TimelineEntry::Comment(c) => &c.created_at,
        TimelineEntry::Commit(c) => &c.date,
        TimelineEntry::LinkedPr(l) => &l.created_at,
    }
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
fn parse_related(node: &Value, kind: &str) -> Vec<RelatedItem> {
    let (key, related_kind) = if kind == "issue" {
        ("closedByPullRequestsReferences", "pr")
    } else {
        ("closingIssuesReferences", "issue")
    };
    node[key]["nodes"]
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
        .unwrap_or_default()
}

/// timeline の相互参照イベント(この Issue/PR にどこかから言及したアイテム)。
/// 閲覧権限のない source は空オブジェクトで返るので filter_map で落ちる
fn parse_cross_refs(node: &Value) -> Vec<RelatedItem> {
    node["timelineItems"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| {
                    let s = &n["source"];
                    let kind = match s["__typename"].as_str()? {
                        "Issue" => "issue",
                        "PullRequest" => "pr",
                        _ => return None,
                    };
                    Some(RelatedItem {
                        kind: kind.to_string(),
                        number: s["number"].as_i64()?,
                        title: s["title"].as_str()?.to_string(),
                        url: s["url"].as_str()?.to_string(),
                        state: s["state"].as_str().unwrap_or_default().to_string(),
                        is_draft: s["isDraft"].as_bool().unwrap_or(false),
                        repo: s["repository"]["nameWithOwner"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// GitHub 描画済み本文 HTML から、他の Issue/PR への言及リンクを抽出する。
/// クエリ・フラグメントは無視して正規形に直し、自分自身と重複は除く
fn extract_referenced_urls(body_html: &str, self_url: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut rest = body_html;
    while let Some(pos) = rest.find("href=\"") {
        rest = &rest[pos + 6..];
        let Some(end) = rest.find('"') else { break };
        let href = &rest[..end];
        rest = &rest[end..];
        let Some(path) = href.strip_prefix("https://github.com/") else {
            continue;
        };
        let path = path.split(['?', '#']).next().unwrap_or(path);
        let segs: Vec<&str> = path.split('/').collect();
        if segs.len() != 4 || !(segs[2] == "issues" || segs[2] == "pull") {
            continue;
        }
        if segs[3].is_empty() || !segs[3].bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let canonical = format!("https://github.com/{}/{}/{}/{}", segs[0], segs[1], segs[2], segs[3]);
        if canonical != self_url && !urls.contains(&canonical) {
            urls.push(canonical);
        }
    }
    urls
}

/// 本文から抽出した言及先 URL を RelatedItem に解決する(エイリアス付き一括取得)。
/// 削除済み・権限外のリソースは null で返るので単に落ちる
async fn resolve_related_urls(state: &AppState, urls: &[String]) -> Result<Vec<RelatedItem>, String> {
    if urls.is_empty() {
        return Ok(Vec::new());
    }
    let mut vars_decl = Vec::new();
    let mut fields = Vec::new();
    let mut variables = serde_json::Map::new();
    for (i, url) in urls.iter().enumerate() {
        vars_decl.push(format!("$u{i}: URI!"));
        fields.push(format!(
            "i{i}: resource(url: $u{i}) {{ __typename \
             ... on Issue {{ number title url state repository {{ nameWithOwner }} }} \
             ... on PullRequest {{ number title url state isDraft repository {{ nameWithOwner }} }} }}"
        ));
        variables.insert(format!("u{i}"), Value::String(url.clone()));
    }
    let query = format!("query({}) {{ {} }}", vars_decl.join(", "), fields.join(" "));
    let data = state.graphql(&query, Value::Object(variables)).await?;
    let mut results = Vec::new();
    for i in 0..urls.len() {
        let node = &data[format!("i{i}")];
        let kind = match node["__typename"].as_str() {
            Some("Issue") => "issue",
            Some("PullRequest") => "pr",
            _ => continue,
        };
        let Some(number) = node["number"].as_i64() else { continue };
        let (Some(title), Some(item_url)) = (node["title"].as_str(), node["url"].as_str()) else {
            continue;
        };
        results.push(RelatedItem {
            kind: kind.to_string(),
            number,
            title: title.to_string(),
            url: item_url.to_string(),
            state: node["state"].as_str().unwrap_or_default().to_string(),
            is_draft: node["isDraft"].as_bool().unwrap_or(false),
            repo: node["repository"]["nameWithOwner"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        });
    }
    Ok(results)
}

const PROJECT_ITEMS_FRAGMENT: &str = r#"
projectItems(first: 10) {
  nodes {
    id
    project {
      id title number url
      field(name: "Status") {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
    }
    fieldValueByName(name: "Status") {
      ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
    }
  }
}
"#;

/// アイテムが所属する Project (v2) と Status を取得する。
/// トークンに read:project スコープが必要なため DETAIL_QUERY とは分離し、
/// スコープ不足(Ok(None))と他のエラー(Err)を呼び出し側で区別できるようにする
async fn fetch_project_items(
    state: &AppState,
    url: &str,
) -> Result<Option<Vec<ProjectItemInfo>>, String> {
    let query = format!(
        "query($url: URI!) {{ resource(url: $url) {{ \
         ... on Issue {{ {PROJECT_ITEMS_FRAGMENT} }} \
         ... on PullRequest {{ {PROJECT_ITEMS_FRAGMENT} }} }} }}"
    );
    let data = match state.graphql(&query, json!({ "url": url })).await {
        Ok(data) => data,
        Err(e) if e.contains("read:project") || e.contains("INSUFFICIENT_SCOPES") => {
            return Ok(None);
        }
        Err(e) => return Err(e),
    };
    let projects = data["resource"]["projectItems"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| {
                    let p = &n["project"];
                    Some(ProjectItemInfo {
                        item_id: n["id"].as_str()?.to_string(),
                        project_id: p["id"].as_str()?.to_string(),
                        title: p["title"].as_str().unwrap_or_default().to_string(),
                        number: p["number"].as_i64().unwrap_or(0),
                        url: p["url"].as_str().unwrap_or_default().to_string(),
                        status: n["fieldValueByName"]["name"].as_str().map(String::from),
                        status_option_id: n["fieldValueByName"]["optionId"].as_str().map(String::from),
                        status_field_id: p["field"]["id"].as_str().map(String::from),
                        status_options: p["field"]["options"]
                            .as_array()
                            .map(|os| {
                                os.iter()
                                    .filter_map(|o| {
                                        Some(ProjectStatusOption {
                                            id: o["id"].as_str()?.to_string(),
                                            name: o["name"].as_str()?.to_string(),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Some(projects))
}

/// レビュワー追加 UI の候補 = リポジトリの assignable ユーザー(先頭100名)。
/// Team はスコープが別途必要になるため候補には含めない
pub async fn list_reviewer_candidates(state: &AppState, repo: &str) -> Result<Vec<String>, String> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| format!("不正なリポジトリ名です: {repo}"))?;
    let data = state
        .graphql(
            r#"
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: 100) { nodes { login } }
  }
}
"#,
            json!({ "owner": owner, "name": name }),
        )
        .await?;
    Ok(data["repository"]["assignableUsers"]["nodes"]
        .as_array()
        .map(|ns| {
            ns.iter()
                .filter_map(|n| n["login"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
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

    let review_requests = parse_review_requests(node);

    let (timeline, timeline_total) =
        if kind == "issue" { parse_issue_timeline(node) } else { parse_timeline(node) };

    // 関連 = Development リンク + 本文で言及した相手 + 自分に言及した相手(URL で重複排除)。
    // 本文言及の解決失敗で詳細表示全体を壊さないよう、そこだけベストエフォート
    let self_url = node["url"].as_str().unwrap_or(url).to_string();
    let dev_related = parse_related(node, kind);
    let incoming = parse_cross_refs(node);
    let mut outgoing_urls =
        extract_referenced_urls(node["bodyHTML"].as_str().unwrap_or_default(), &self_url);
    let known: std::collections::HashSet<&str> = dev_related
        .iter()
        .chain(incoming.iter())
        .map(|r| r.url.as_str())
        .collect();
    outgoing_urls.retain(|u| !known.contains(u.as_str()));
    outgoing_urls.truncate(10);
    let outgoing = match resolve_related_urls(state, &outgoing_urls).await {
        Ok(items) => items,
        Err(e) => {
            eprintln!("関連リンクの解決に失敗: {e}");
            Vec::new()
        }
    };
    let mut related: Vec<RelatedItem> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for r in dev_related.into_iter().chain(outgoing).chain(incoming) {
        if r.url != self_url && seen.insert(r.url.clone()) {
            related.push(r);
        }
    }
    let related_total = related.len() as i64;
    related.truncate(10);

    // Project (v2) はスコープ不足で取れないことがある。詳細表示全体は壊さず、
    // スコープ不足はフラグで伝えて UI 側で案内する
    let (projects, projects_scope_missing) = match fetch_project_items(state, &self_url).await {
        Ok(Some(items)) => (items, false),
        Ok(None) => (Vec::new(), true),
        Err(e) => {
            eprintln!("プロジェクト情報の取得に失敗: {e}");
            (Vec::new(), false)
        }
    };

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
        review_requests,
        timeline,
        timeline_total,
        projects,
        projects_scope_missing,
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
        assert!(detail.timeline_total > 0);
        assert!(
            detail.timeline.iter().any(|e| matches!(e, TimelineEntry::Comment(_))),
            "issue timeline should contain comments"
        );
        // この Issue は他の Issue から複数回言及されている(相互参照メンションの実データ検証)
        assert!(!detail.related.is_empty(), "相互参照メンションが取れるはず");
    }

    #[test]
    fn issue_timeline_merges_linked_prs_and_total_counts_only_shown_kinds() {
        let node = json!({
            "timeline": {
                // コメントは 12 件中、取得枠に入ったのが 2 件(=隠れた古いコメントは 10 件)
                "totalCount": 12,
                "nodes": [
                    { "__typename": "IssueComment", "author": { "login": "a", "avatarUrl": "av" },
                      "bodyHTML": "<p>old</p>", "createdAt": "2026-07-01T00:00:00Z" },
                    { "__typename": "IssueComment", "author": { "login": "b", "avatarUrl": "av" },
                      "bodyHTML": "<p>new</p>", "createdAt": "2026-07-03T00:00:00Z" }
                ]
            },
            "timelineItems": {
                "nodes": [
                    // Issue 起点の言及はタイムラインに出さない(「関連」行に任せる)
                    { "createdAt": "2026-07-02T00:00:00Z", "actor": { "login": "noise" },
                      "source": { "__typename": "Issue", "number": 9, "title": "n", "url": "u9",
                                   "state": "OPEN", "repository": { "nameWithOwner": "o/r" } } },
                    { "createdAt": "2026-07-02T00:00:00Z", "actor": { "login": "c" },
                      "source": { "__typename": "PullRequest", "number": 5, "title": "fix", "url": "u5",
                                   "state": "OPEN", "isDraft": false,
                                   "repository": { "nameWithOwner": "o/r" } } }
                ]
            }
        });

        let (entries, total) = parse_issue_timeline(&node);
        // コメント 2 件 + PR 起点の言及 1 件が時系列順に並ぶ
        assert_eq!(entries.len(), 3);
        assert!(matches!(&entries[0], TimelineEntry::Comment(c) if c.body_html == "<p>old</p>"));
        assert!(
            matches!(&entries[1], TimelineEntry::LinkedPr(l) if l.number == 5 && l.actor.as_deref() == Some("c"))
        );
        assert!(matches!(&entries[2], TimelineEntry::Comment(c) if c.body_html == "<p>new</p>"));
        // total は「コメント総数 + 表示した LinkedPr 数」。差分 10 が隠れた古いコメント数になる
        assert_eq!(total, 13);
        assert_eq!(total - entries.len() as i64, 10);
    }

    #[test]
    fn extracts_mentioned_item_urls_from_body_html() {
        let body = r##"<p>
            <a href="https://github.com/o/r/issues/12">#12</a>
            <a href="https://github.com/o/r/pull/34#issuecomment-99">comment link</a>
            <a href="https://github.com/o/r/issues/12?foo=1">duplicate</a>
            <a href="https://github.com/o/r/issues/56">self</a>
            <a href="https://github.com/o/r">repo root</a>
            <a href="https://github.com/o/r/compare/a...b">compare</a>
            <a href="https://example.com/o/r/issues/78">other host</a>
            <a href="https://github.com/o/r/issues/abc">not a number</a>
        </p>"##;
        let urls = extract_referenced_urls(body, "https://github.com/o/r/issues/56");
        assert_eq!(
            urls,
            vec![
                "https://github.com/o/r/issues/12".to_string(),
                "https://github.com/o/r/pull/34".to_string(),
            ]
        );
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
        // 紐づいた PR は(コメント専用になった timeline とは別の)相互参照クエリから合流する
        assert!(
            issue
                .timeline
                .iter()
                .any(|e| matches!(e, TimelineEntry::LinkedPr(l) if l.number == 15677)),
            "Issue のタイムラインに紐づいた PR が出るはず"
        );
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
        assert!(detail.timeline_total >= detail.timeline.len() as i64);
        let commit = detail
            .timeline
            .iter()
            .find_map(|e| match e {
                TimelineEntry::Commit(c) => Some(c),
                _ => None,
            })
            .expect("PR timeline should contain commits");
        assert!(!commit.short_oid.is_empty());
        assert!(commit.url.starts_with("https://"));
    }
}


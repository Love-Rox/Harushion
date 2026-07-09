use std::collections::{BinaryHeap, HashMap, HashSet};

use serde::Serialize;
use serde_json::json;

use crate::github::AppState;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphPr {
    pub number: i64,
    pub title: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBranch {
    pub name: String,
    pub tip_oid: String,
    pub is_default: bool,
    pub ahead: i64,
    pub behind: i64,
    pub pr: Option<GraphPr>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub oid: String,
    pub short_oid: String,
    pub message: String,
    pub author: Option<String>,
    pub author_avatar: Option<String>,
    pub date: String,
    pub lane: usize,
    pub parents: Vec<String>,
    pub branch_tips: Vec<String>,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchGraph {
    pub repo: String,
    pub default_branch: String,
    pub branches: Vec<GraphBranch>,
    pub commits: Vec<GraphCommit>,
    pub lane_count: usize,
}

/// 表示するコミット数の上限。トポソート後の新しい側から残す。
const MAX_COMMITS: usize = 150;
const BRANCHES_FIRST: u32 = 25;
const HISTORY_FIRST: u32 = 40;

#[derive(Clone)]
struct RawCommit {
    oid: String,
    short_oid: String,
    message: String,
    author: Option<String>,
    author_avatar: Option<String>,
    date: String,
    parents: Vec<String>,
    url: String,
}

/// 子→親の順(git log --topo-order 相当)に並べる。同時に取り出せる中では新しい日付を優先。
fn topo_sort(commits: Vec<RawCommit>) -> Vec<RawCommit> {
    let index: HashMap<String, usize> = commits
        .iter()
        .enumerate()
        .map(|(i, c)| (c.oid.clone(), i))
        .collect();

    // child_count[i] = セット内に存在する i の子の数
    let mut child_count = vec![0usize; commits.len()];
    for c in &commits {
        for p in &c.parents {
            if let Some(&i) = index.get(p) {
                child_count[i] += 1;
            }
        }
    }

    // (date, oid, index) の max-heap: 子を持たない(=先端)コミットから新しい順に取り出す
    let mut heap: BinaryHeap<(String, String, usize)> = commits
        .iter()
        .enumerate()
        .filter(|(i, _)| child_count[*i] == 0)
        .map(|(i, c)| (c.date.clone(), c.oid.clone(), i))
        .collect();

    let mut order = Vec::with_capacity(commits.len());
    let mut emitted = vec![false; commits.len()];
    while let Some((_, _, i)) = heap.pop() {
        if emitted[i] {
            continue;
        }
        emitted[i] = true;
        order.push(i);
        for p in &commits[i].parents {
            if let Some(&pi) = index.get(p) {
                child_count[pi] -= 1;
                if child_count[pi] == 0 {
                    heap.push((commits[pi].date.clone(), commits[pi].oid.clone(), pi));
                }
            }
        }
    }
    // git の履歴は DAG なので通常ここには残らないが、保険として日付順で残りを流す
    let mut rest: Vec<usize> = (0..commits.len()).filter(|i| !emitted[*i]).collect();
    rest.sort_by(|a, b| commits[*b].date.cmp(&commits[*a].date));
    order.extend(rest);

    let mut by_index: Vec<Option<RawCommit>> = commits.into_iter().map(Some).collect();
    order.into_iter().map(|i| by_index[i].take().expect("unique index")).collect()
}

/// トポソート済みコミット列にレーン番号を割り当てる。
/// 各レーンは「次に来るはずの親 oid」を保持し、先頭一致したレーンを引き継ぐ。
fn assign_lanes(sorted: &[RawCommit]) -> (Vec<usize>, usize) {
    let in_set: HashSet<&str> = sorted.iter().map(|c| c.oid.as_str()).collect();
    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut result = vec![0usize; sorted.len()];
    let mut lane_count = 0usize;

    for (i, c) in sorted.iter().enumerate() {
        let expecting: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(_, l)| l.as_deref() == Some(c.oid.as_str()))
            .map(|(j, _)| j)
            .collect();

        let lane = if let Some(&first) = expecting.first() {
            // このコミットに合流する他のレーンは閉じる
            for &j in &expecting[1..] {
                lanes[j] = None;
            }
            first
        } else {
            match lanes.iter().position(Option::is_none) {
                Some(j) => j,
                None => {
                    lanes.push(None);
                    lanes.len() - 1
                }
            }
        };
        result[i] = lane;

        let mut parents_in_set = c.parents.iter().filter(|p| in_set.contains(p.as_str()));
        // 第1親でレーンを継続、親が範囲外なら閉じる
        lanes[lane] = parents_in_set.next().cloned();
        // マージコミットの第2親以降: どのレーンもまだ予約していなければ新レーンを確保
        for p in parents_in_set {
            if !lanes.iter().any(|l| l.as_deref() == Some(p.as_str())) {
                match lanes.iter().position(Option::is_none) {
                    Some(j) => lanes[j] = Some(p.clone()),
                    None => lanes.push(Some(p.clone())),
                }
            }
        }
        lane_count = lane_count.max(lanes.len());
    }
    (result, lane_count.max(1))
}

fn parse_repo(repo: &str) -> Result<(String, String), String> {
    let mut parts = repo.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(format!("リポジトリ名は owner/name 形式で指定してください: {repo}"));
    };
    let ok = |s: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !ok(owner) || !ok(name) {
        return Err(format!("不正なリポジトリ名です: {repo}"));
    }
    Ok((owner.to_string(), name.to_string()))
}

pub fn validate_repo(repo: &str) -> Result<(), String> {
    parse_repo(repo).map(|_| ())
}

const DEFAULT_BRANCH_QUERY: &str = r#"
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { defaultBranchRef { name } }
}
"#;

const GRAPH_QUERY: &str = r#"
query($owner: String!, $name: String!, $head: String!, $branches: Int!, $history: Int!) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: $branches) {
      nodes {
        name
        compare(headRef: $head) { aheadBy behindBy }
        target {
          ... on Commit {
            oid
            committedDate
            history(first: $history) {
              nodes {
                oid abbreviatedOid messageHeadline committedDate url
                author { name avatarUrl user { login } }
                parents(first: 4) { nodes { oid } }
              }
            }
          }
        }
      }
    }
    pullRequests(states: OPEN, first: 50) {
      nodes { number title url headRefName }
    }
  }
}
"#;

pub async fn fetch_branch_graph(state: &AppState, repo: &str) -> Result<BranchGraph, String> {
    let (owner, name) = parse_repo(repo)?;

    let data = state
        .graphql(DEFAULT_BRANCH_QUERY, json!({ "owner": owner, "name": name }))
        .await?;
    let Some(default_branch) = data["repository"]["defaultBranchRef"]["name"]
        .as_str()
        .map(String::from)
    else {
        return Err(format!("{repo} にブランチがありません(空のリポジトリ?)"));
    };

    let data = state
        .graphql(
            GRAPH_QUERY,
            json!({
                "owner": owner, "name": name, "head": default_branch,
                "branches": BRANCHES_FIRST, "history": HISTORY_FIRST,
            }),
        )
        .await?;
    let repo_node = &data["repository"];

    // PR: headRefName → PR 情報
    let prs: HashMap<String, GraphPr> = repo_node["pullRequests"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| {
                    Some((
                        n["headRefName"].as_str()?.to_string(),
                        GraphPr {
                            number: n["number"].as_i64()?,
                            title: n["title"].as_str().unwrap_or_default().to_string(),
                            url: n["url"].as_str()?.to_string(),
                        },
                    ))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut branches: Vec<GraphBranch> = Vec::new();
    let mut branch_dates: HashMap<String, String> = HashMap::new();
    let mut commit_map: HashMap<String, RawCommit> = HashMap::new();

    for node in repo_node["refs"]["nodes"].as_array().into_iter().flatten() {
        let Some(branch_name) = node["name"].as_str() else { continue };
        let Some(tip_oid) = node["target"]["oid"].as_str() else { continue };
        let compare = &node["compare"];
        branches.push(GraphBranch {
            name: branch_name.to_string(),
            tip_oid: tip_oid.to_string(),
            is_default: branch_name == default_branch,
            // compare は「このブランチを base、デフォルトブランチを head」とした比較なので
            // aheadBy = デフォルト側が進んでいる数 = このブランチの behind
            ahead: compare["behindBy"].as_i64().unwrap_or(0),
            behind: compare["aheadBy"].as_i64().unwrap_or(0),
            pr: prs.get(branch_name).cloned(),
        });
        branch_dates.insert(
            branch_name.to_string(),
            node["target"]["committedDate"].as_str().unwrap_or_default().to_string(),
        );

        for c in node["target"]["history"]["nodes"].as_array().into_iter().flatten() {
            let Some(oid) = c["oid"].as_str() else { continue };
            if commit_map.contains_key(oid) {
                continue;
            }
            commit_map.insert(
                oid.to_string(),
                RawCommit {
                    oid: oid.to_string(),
                    short_oid: c["abbreviatedOid"].as_str().unwrap_or(&oid[..7.min(oid.len())]).to_string(),
                    message: c["messageHeadline"].as_str().unwrap_or_default().to_string(),
                    author: c["author"]["user"]["login"]
                        .as_str()
                        .or(c["author"]["name"].as_str())
                        .map(String::from),
                    author_avatar: c["author"]["avatarUrl"].as_str().map(String::from),
                    date: c["committedDate"].as_str().unwrap_or_default().to_string(),
                    parents: c["parents"]["nodes"]
                        .as_array()
                        .map(|ps| ps.iter().filter_map(|p| p["oid"].as_str().map(String::from)).collect())
                        .unwrap_or_default(),
                    url: c["url"].as_str().unwrap_or_default().to_string(),
                },
            );
        }
    }

    // デフォルトブランチ先頭、以降は先端コミットの新しい順
    branches.sort_by(|a, b| {
        b.is_default.cmp(&a.is_default).then_with(|| {
            let da = branch_dates.get(&a.name).map(String::as_str).unwrap_or("");
            let db = branch_dates.get(&b.name).map(String::as_str).unwrap_or("");
            db.cmp(da)
        })
    });

    let mut sorted = topo_sort(commit_map.into_values().collect());
    sorted.truncate(MAX_COMMITS);
    let (lanes, lane_count) = assign_lanes(&sorted);

    let mut tips: HashMap<&str, Vec<String>> = HashMap::new();
    for b in &branches {
        tips.entry(b.tip_oid.as_str()).or_default().push(b.name.clone());
    }

    let commits = sorted
        .iter()
        .zip(lanes)
        .map(|(c, lane)| GraphCommit {
            oid: c.oid.clone(),
            short_oid: c.short_oid.clone(),
            message: c.message.clone(),
            author: c.author.clone(),
            author_avatar: c.author_avatar.clone(),
            date: c.date.clone(),
            lane,
            parents: c.parents.clone(),
            branch_tips: tips.get(c.oid.as_str()).cloned().unwrap_or_default(),
            url: c.url.clone(),
        })
        .collect();

    Ok(BranchGraph {
        repo: format!("{owner}/{name}"),
        default_branch,
        branches,
        commits,
        lane_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(oid: &str, date: &str, parents: &[&str]) -> RawCommit {
        RawCommit {
            oid: oid.into(),
            short_oid: oid.chars().take(7).collect(),
            message: format!("commit {oid}"),
            author: None,
            author_avatar: None,
            date: date.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            url: String::new(),
        }
    }

    fn oids(sorted: &[RawCommit]) -> Vec<&str> {
        sorted.iter().map(|c| c.oid.as_str()).collect()
    }

    #[test]
    fn linear_history_is_single_lane() {
        // c3 -> c2 -> c1
        let sorted = topo_sort(vec![
            commit("c1", "2026-01-01T00:00:00Z", &[]),
            commit("c3", "2026-01-03T00:00:00Z", &["c2"]),
            commit("c2", "2026-01-02T00:00:00Z", &["c1"]),
        ]);
        assert_eq!(oids(&sorted), ["c3", "c2", "c1"]);
        let (lanes, count) = assign_lanes(&sorted);
        assert_eq!(lanes, [0, 0, 0]);
        assert_eq!(count, 1);
    }

    #[test]
    fn branch_and_merge_uses_two_lanes() {
        //   m (merge of b into a2)
        //   |\
        //  a2 b
        //   |/
        //  base
        let sorted = topo_sort(vec![
            commit("base", "2026-01-01T00:00:00Z", &[]),
            commit("a2", "2026-01-02T00:00:00Z", &["base"]),
            commit("b", "2026-01-03T00:00:00Z", &["base"]),
            commit("m", "2026-01-04T00:00:00Z", &["a2", "b"]),
        ]);
        assert_eq!(sorted[0].oid, "m");
        assert_eq!(sorted[3].oid, "base");
        let (lanes, count) = assign_lanes(&sorted);
        let lane_of = |oid: &str| lanes[sorted.iter().position(|c| c.oid == oid).unwrap()];
        assert_eq!(lane_of("m"), 0);
        assert_eq!(lane_of("a2"), 0, "first parent keeps the merge lane");
        assert_ne!(lane_of("b"), 0, "second parent gets its own lane");
        assert_eq!(lane_of("base"), 0, "merge base returns to lane 0");
        assert_eq!(count, 2);
    }

    #[test]
    fn children_always_precede_parents_even_with_odd_dates() {
        // 日付が逆転していても(rebase等)、子が親より先に並ぶ
        let sorted = topo_sort(vec![
            commit("old-child", "2026-01-01T00:00:00Z", &["new-parent"]),
            commit("new-parent", "2026-01-05T00:00:00Z", &[]),
        ]);
        assert_eq!(oids(&sorted), ["old-child", "new-parent"]);
    }

    #[test]
    fn two_independent_branches_get_parallel_lanes() {
        // tip-a -> base, tip-b -> base(範囲外)
        let sorted = topo_sort(vec![
            commit("tip-a", "2026-01-05T00:00:00Z", &["base"]),
            commit("tip-b", "2026-01-04T00:00:00Z", &["outside"]),
            commit("base", "2026-01-01T00:00:00Z", &[]),
        ]);
        assert_eq!(oids(&sorted), ["tip-a", "tip-b", "base"]);
        let (lanes, count) = assign_lanes(&sorted);
        assert_eq!(lanes[0], 0);
        assert_eq!(lanes[1], 1, "independent branch gets its own lane");
        assert_eq!(lanes[2], 0, "base continues tip-a's lane");
        assert_eq!(count, 2);
        // tip-b の親は範囲外なのでレーン1はそこで閉じる(スタブ表示はフロント側)
    }

    #[test]
    fn shared_history_from_two_tips_converges() {
        // 2 ブランチが同じ親に合流するケース: 2 レーンが shared で 1 本になる
        let sorted = topo_sort(vec![
            commit("tip-a", "2026-01-05T00:00:00Z", &["shared"]),
            commit("tip-b", "2026-01-04T00:00:00Z", &["shared"]),
            commit("shared", "2026-01-01T00:00:00Z", &[]),
        ]);
        let (lanes, count) = assign_lanes(&sorted);
        assert_eq!(lanes[0], 0);
        assert_eq!(lanes[1], 1);
        assert_eq!(lanes[2], 0, "shared parent lands on the leftmost expecting lane");
        assert_eq!(count, 2);
    }

    #[tokio::test]
    #[ignore = "requires gh auth and network"]
    async fn fetches_branch_graph_from_real_repo() {
        let state = AppState::new();
        let graph = fetch_branch_graph(&state, "Love-Rox/Harushion")
            .await
            .expect("graph fetch failed");
        assert_eq!(graph.repo, "Love-Rox/Harushion");
        assert_eq!(graph.default_branch, "main");
        assert!(!graph.commits.is_empty());
        assert!(graph.branches.iter().any(|b| b.is_default));
        assert!(graph.lane_count >= 1);

        // 表示順の不変条件: 子は必ず親より先に現れる
        let pos: HashMap<&str, usize> = graph
            .commits
            .iter()
            .enumerate()
            .map(|(i, c)| (c.oid.as_str(), i))
            .collect();
        for (i, c) in graph.commits.iter().enumerate() {
            assert!(c.lane < graph.lane_count);
            for p in &c.parents {
                if let Some(&pi) = pos.get(p.as_str()) {
                    assert!(i < pi, "child {} must precede parent {}", c.oid, p);
                }
            }
        }
        // デフォルトブランチの先端がコミット列に含まれ、branchTips が付いている
        let default_tip = &graph.branches.iter().find(|b| b.is_default).unwrap().tip_oid;
        assert!(graph
            .commits
            .iter()
            .any(|c| &c.oid == default_tip && c.branch_tips.contains(&graph.default_branch)));
    }

    #[tokio::test]
    #[ignore = "requires gh auth and network"]
    async fn handles_merge_heavy_public_repo() {
        let state = AppState::new();
        let graph = fetch_branch_graph(&state, "tauri-apps/tauri")
            .await
            .expect("graph fetch failed");
        assert!(graph.commits.len() > 50);
        assert!(graph.lane_count >= 2, "merge-heavy repo should need multiple lanes");
        assert!(graph.branches.len() > 1);
        // マージコミット(親2つ以上)が存在し、レーンが上限内に収まる
        assert!(graph.commits.iter().any(|c| c.parents.len() >= 2));
        assert!(graph.commits.iter().all(|c| c.lane < graph.lane_count));
    }

    #[test]
    fn parse_repo_validation() {
        assert!(parse_repo("Love-Rox/Harushion").is_ok());
        assert!(parse_repo("a.b/c_d-e").is_ok());
        assert!(parse_repo("noslash").is_err());
        assert!(parse_repo("a/b/c").is_err());
        assert!(parse_repo("/name").is_err());
        assert!(parse_repo("owner/").is_err());
        assert!(parse_repo("-owner/name").is_err());
        assert!(parse_repo("owner/na me").is_err());
    }
}

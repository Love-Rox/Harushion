use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::github::LabelInfo;

/// フロントから受け取る GitHub 操作。gh CLI のサブコマンドに 1:1 で対応させる。
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ItemAction {
    Comment { body: String },
    Close,
    Reopen,
    Merge { method: String, delete_branch: bool },
    Review { verdict: String, body: Option<String> },
    Ready { undo: bool },
    UpdateBranch,
    EditLabels { add: Vec<String>, remove: Vec<String> },
    EditReviewers { add: Vec<String>, remove: Vec<String> },
    AssignMe { remove: bool },
    SetProjectStatus { item_id: String, project_id: String, field_id: String, option_id: String },
}

/// gh の起動引数と stdin 入力。本文は引数ではなく stdin で渡す(長文・改行・引用符対策)。
#[derive(Debug, PartialEq)]
pub struct GhInvocation {
    pub args: Vec<String>,
    pub stdin: Option<String>,
}

fn strs(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

/// ItemAction を gh CLI 引数に変換する純関数。ここが「gh でできる操作」の対応表。
pub fn build_invocation(url: &str, kind: &str, action: &ItemAction) -> Result<GhInvocation, String> {
    if !url.starts_with("https://github.com/") {
        return Err("GitHub の URL ではありません".into());
    }
    let noun = match kind {
        "issue" => "issue",
        "pr" => "pr",
        other => return Err(format!("不明な種別です: {other}")),
    };
    let pr_only = |name: &str| -> Result<(), String> {
        if noun == "pr" {
            Ok(())
        } else {
            Err(format!("{name}は Pull Request のみ可能です"))
        }
    };

    let mut stdin = None;
    let args = match action {
        ItemAction::Comment { body } => {
            if body.trim().is_empty() {
                return Err("コメント本文が空です".into());
            }
            stdin = Some(body.clone());
            strs(&[noun, "comment", url, "--body-file", "-"])
        }
        ItemAction::Close => strs(&[noun, "close", url]),
        ItemAction::Reopen => strs(&[noun, "reopen", url]),
        ItemAction::Merge { method, delete_branch } => {
            pr_only("マージ")?;
            let flag = match method.as_str() {
                "merge" => "--merge",
                "squash" => "--squash",
                "rebase" => "--rebase",
                other => return Err(format!("不明なマージ方式です: {other}")),
            };
            let mut a = strs(&["pr", "merge", url, flag]);
            if *delete_branch {
                a.push("--delete-branch".into());
            }
            a
        }
        ItemAction::Review { verdict, body } => {
            pr_only("レビュー")?;
            let flag = match verdict.as_str() {
                "approve" => "--approve",
                "requestChanges" => "--request-changes",
                "comment" => "--comment",
                other => return Err(format!("不明なレビュー種別です: {other}")),
            };
            let mut a = strs(&["pr", "review", url, flag]);
            match body {
                Some(b) if !b.trim().is_empty() => {
                    stdin = Some(b.clone());
                    a.extend(strs(&["--body-file", "-"]));
                }
                _ if verdict == "approve" => {}
                _ => return Err("レビューコメントを入力してください".into()),
            }
            a
        }
        ItemAction::Ready { undo } => {
            pr_only("レビュー準備状態の変更")?;
            let mut a = strs(&["pr", "ready", url]);
            if *undo {
                a.push("--undo".into());
            }
            a
        }
        ItemAction::UpdateBranch => {
            pr_only("ブランチ更新")?;
            strs(&["pr", "update-branch", url])
        }
        ItemAction::EditLabels { add, remove } => {
            if add.is_empty() && remove.is_empty() {
                return Err("ラベルの変更がありません".into());
            }
            let mut a = strs(&[noun, "edit", url]);
            if !add.is_empty() {
                a.push("--add-label".into());
                a.push(add.join(","));
            }
            if !remove.is_empty() {
                a.push("--remove-label".into());
                a.push(remove.join(","));
            }
            a
        }
        ItemAction::EditReviewers { add, remove } => {
            pr_only("レビュワーの変更")?;
            if add.is_empty() && remove.is_empty() {
                return Err("レビュワーの変更がありません".into());
            }
            // login はカンマ結合で渡すため、区切り文字やフラグに化ける値を拒否する。
            // [ ] は Bot の login("dependabot[bot]" 等)の削除に必要なので許可
            for login in add.iter().chain(remove.iter()) {
                let valid = !login.is_empty()
                    && !login.starts_with('-')
                    && login
                        .chars()
                        .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '@' | '[' | ']'));
                if !valid {
                    return Err(format!("不正なレビュワー名です: {login}"));
                }
            }
            let mut a = strs(&["pr", "edit", url]);
            if !add.is_empty() {
                a.push("--add-reviewer".into());
                a.push(add.join(","));
            }
            if !remove.is_empty() {
                a.push("--remove-reviewer".into());
                a.push(remove.join(","));
            }
            a
        }
        ItemAction::AssignMe { remove } => {
            let flag = if *remove { "--remove-assignee" } else { "--add-assignee" };
            strs(&[noun, "edit", url, flag, "@me"])
        }
        ItemAction::SetProjectStatus { item_id, project_id, field_id, option_id } => {
            for id in [item_id, project_id, field_id, option_id] {
                if id.is_empty() || id.starts_with('-') {
                    return Err(format!("不正な Project ID です: {id}"));
                }
            }
            strs(&[
                "project", "item-edit",
                "--id", item_id,
                "--project-id", project_id,
                "--field-id", field_id,
                "--single-select-option-id", option_id,
            ])
        }
    };
    Ok(GhInvocation { args, stdin })
}

/// gh を実行して stdout を返す。失敗時は stderr をユーザー向けエラーにする。
pub async fn run_gh(inv: GhInvocation) -> Result<String, String> {
    let mut child = Command::new("gh")
        .args(&inv.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("gh コマンドを実行できませんでした ({e})。GitHub CLI をインストールしてください: https://cli.github.com")
        })?;

    let mut child_stdin = child.stdin.take();
    if let Some(body) = &inv.stdin {
        if let Some(si) = child_stdin.as_mut() {
            si.write_all(body.as_bytes())
                .await
                .map_err(|e| format!("gh への入力に失敗しました: {e}"))?;
        }
    }
    drop(child_stdin); // stdin を閉じて gh に EOF を伝える

    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("gh の実行に失敗しました: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("gh の実行に失敗しました: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// リポジトリのラベル一覧(ラベル編集 UI 用)。
pub async fn list_repo_labels(repo: &str) -> Result<Vec<LabelInfo>, String> {
    let valid = repo.split('/').count() == 2
        && !repo.starts_with('-')
        && repo.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    if !valid {
        return Err(format!("不正なリポジトリ名です: {repo}"));
    }
    let out = run_gh(GhInvocation {
        args: strs(&["label", "list", "-R", repo, "--json", "name,color", "--limit", "100"]),
        stdin: None,
    })
    .await?;
    serde_json::from_str(&out).map_err(|e| format!("ラベル一覧を解釈できませんでした: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://github.com/o/r/issues/1";
    const PR_URL: &str = "https://github.com/o/r/pull/2";

    fn args(inv: &GhInvocation) -> Vec<&str> {
        inv.args.iter().map(String::as_str).collect()
    }

    #[test]
    fn comment_goes_through_stdin() {
        let inv = build_invocation(URL, "issue", &ItemAction::Comment { body: "LGTM 👍".into() }).unwrap();
        assert_eq!(args(&inv), ["issue", "comment", URL, "--body-file", "-"]);
        assert_eq!(inv.stdin.as_deref(), Some("LGTM 👍"));
    }

    #[test]
    fn empty_comment_is_rejected() {
        assert!(build_invocation(URL, "issue", &ItemAction::Comment { body: "  \n".into() }).is_err());
    }

    #[test]
    fn close_and_reopen() {
        let inv = build_invocation(PR_URL, "pr", &ItemAction::Close).unwrap();
        assert_eq!(args(&inv), ["pr", "close", PR_URL]);
        let inv = build_invocation(URL, "issue", &ItemAction::Reopen).unwrap();
        assert_eq!(args(&inv), ["issue", "reopen", URL]);
    }

    #[test]
    fn merge_variants() {
        let inv = build_invocation(
            PR_URL,
            "pr",
            &ItemAction::Merge { method: "squash".into(), delete_branch: true },
        )
        .unwrap();
        assert_eq!(args(&inv), ["pr", "merge", PR_URL, "--squash", "--delete-branch"]);

        assert!(build_invocation(URL, "issue", &ItemAction::Merge { method: "merge".into(), delete_branch: false }).is_err());
        assert!(build_invocation(PR_URL, "pr", &ItemAction::Merge { method: "yolo".into(), delete_branch: false }).is_err());
    }

    #[test]
    fn review_variants() {
        let inv = build_invocation(PR_URL, "pr", &ItemAction::Review { verdict: "approve".into(), body: None }).unwrap();
        assert_eq!(args(&inv), ["pr", "review", PR_URL, "--approve"]);

        let inv = build_invocation(
            PR_URL,
            "pr",
            &ItemAction::Review { verdict: "requestChanges".into(), body: Some("直して".into()) },
        )
        .unwrap();
        assert_eq!(args(&inv), ["pr", "review", PR_URL, "--request-changes", "--body-file", "-"]);
        assert_eq!(inv.stdin.as_deref(), Some("直して"));

        // request-changes / comment は本文必須
        assert!(build_invocation(PR_URL, "pr", &ItemAction::Review { verdict: "requestChanges".into(), body: None }).is_err());
        assert!(build_invocation(PR_URL, "pr", &ItemAction::Review { verdict: "comment".into(), body: Some(" ".into()) }).is_err());
    }

    #[test]
    fn ready_and_update_branch_are_pr_only() {
        let inv = build_invocation(PR_URL, "pr", &ItemAction::Ready { undo: true }).unwrap();
        assert_eq!(args(&inv), ["pr", "ready", PR_URL, "--undo"]);
        assert!(build_invocation(URL, "issue", &ItemAction::Ready { undo: false }).is_err());

        let inv = build_invocation(PR_URL, "pr", &ItemAction::UpdateBranch).unwrap();
        assert_eq!(args(&inv), ["pr", "update-branch", PR_URL]);
        assert!(build_invocation(URL, "issue", &ItemAction::UpdateBranch).is_err());
    }

    #[test]
    fn edit_labels_joins_with_comma() {
        let inv = build_invocation(
            URL,
            "issue",
            &ItemAction::EditLabels { add: vec!["bug".into(), "help wanted".into()], remove: vec!["wip".into()] },
        )
        .unwrap();
        assert_eq!(
            args(&inv),
            ["issue", "edit", URL, "--add-label", "bug,help wanted", "--remove-label", "wip"]
        );
        assert!(build_invocation(URL, "issue", &ItemAction::EditLabels { add: vec![], remove: vec![] }).is_err());
    }

    #[test]
    fn edit_reviewers_joins_with_comma() {
        let inv = build_invocation(
            PR_URL,
            "pr",
            &ItemAction::EditReviewers { add: vec!["monalisa".into(), "o/team-a".into()], remove: vec!["hubot".into()] },
        )
        .unwrap();
        assert_eq!(
            args(&inv),
            ["pr", "edit", PR_URL, "--add-reviewer", "monalisa,o/team-a", "--remove-reviewer", "hubot"]
        );

        // Copilot は "@copilot" 指定
        let inv = build_invocation(PR_URL, "pr", &ItemAction::EditReviewers { add: vec!["@copilot".into()], remove: vec![] }).unwrap();
        assert_eq!(args(&inv), ["pr", "edit", PR_URL, "--add-reviewer", "@copilot"]);

        // Bot の login は "[bot]" サフィックス付きで依頼一覧から削除経路に来る
        let inv = build_invocation(PR_URL, "pr", &ItemAction::EditReviewers { add: vec![], remove: vec!["dependabot[bot]".into()] }).unwrap();
        assert_eq!(args(&inv), ["pr", "edit", PR_URL, "--remove-reviewer", "dependabot[bot]"]);

        // PR 限定・空変更・不正な login(フラグ/カンマ注入)は拒否
        assert!(build_invocation(URL, "issue", &ItemAction::EditReviewers { add: vec!["monalisa".into()], remove: vec![] }).is_err());
        assert!(build_invocation(PR_URL, "pr", &ItemAction::EditReviewers { add: vec![], remove: vec![] }).is_err());
        assert!(build_invocation(PR_URL, "pr", &ItemAction::EditReviewers { add: vec!["--evil".into()], remove: vec![] }).is_err());
        assert!(build_invocation(PR_URL, "pr", &ItemAction::EditReviewers { add: vec!["a,b".into()], remove: vec![] }).is_err());
        assert!(build_invocation(PR_URL, "pr", &ItemAction::EditReviewers { add: vec!["".into()], remove: vec![] }).is_err());
    }

    #[test]
    fn assign_me_toggles_flag() {
        let inv = build_invocation(URL, "issue", &ItemAction::AssignMe { remove: false }).unwrap();
        assert_eq!(args(&inv), ["issue", "edit", URL, "--add-assignee", "@me"]);
        let inv = build_invocation(URL, "issue", &ItemAction::AssignMe { remove: true }).unwrap();
        assert_eq!(args(&inv), ["issue", "edit", URL, "--remove-assignee", "@me"]);
    }

    #[test]
    fn set_project_status_uses_node_ids() {
        let action = ItemAction::SetProjectStatus {
            item_id: "PVTI_x".into(),
            project_id: "PVT_x".into(),
            field_id: "PVTSSF_x".into(),
            option_id: "abc123".into(),
        };
        let inv = build_invocation(URL, "issue", &action).unwrap();
        assert_eq!(
            args(&inv),
            [
                "project", "item-edit",
                "--id", "PVTI_x",
                "--project-id", "PVT_x",
                "--field-id", "PVTSSF_x",
                "--single-select-option-id", "abc123",
            ]
        );

        // 空・先頭ハイフンの ID は引数注入防止のため拒否
        let bad = ItemAction::SetProjectStatus {
            item_id: "--evil".into(),
            project_id: "PVT_x".into(),
            field_id: "PVTSSF_x".into(),
            option_id: "abc123".into(),
        };
        assert!(build_invocation(URL, "issue", &bad).is_err());
    }

    #[test]
    fn rejects_non_github_urls_and_unknown_kind() {
        assert!(build_invocation("https://evil.example/x", "issue", &ItemAction::Close).is_err());
        assert!(build_invocation(URL, "gist", &ItemAction::Close).is_err());
    }

    /// run_gh の subprocess 経路(起動・stdout 取得・JSON パース)を読み取り専用で通す。
    #[tokio::test]
    #[ignore = "requires gh auth and network"]
    async fn lists_labels_readonly_via_real_gh() {
        let labels = list_repo_labels("tauri-apps/tauri").await.expect("label list failed");
        assert!(!labels.is_empty());
        assert!(labels.iter().all(|l| !l.name.is_empty()));
    }

    /// サンドボックスリポジトリに実 Issue を作り、操作経路(build_invocation → run_gh)を
    /// 端から端まで通す。環境変数 HARUSHION_SANDBOX_REPO を設定したときのみ実行される:
    /// `HARUSHION_SANDBOX_REPO=owner/repo cargo test -- --ignored mutating_sandbox`
    #[tokio::test]
    #[ignore = "mutates a real repo; opt-in via HARUSHION_SANDBOX_REPO"]
    async fn mutating_sandbox_roundtrip() {
        let Ok(repo) = std::env::var("HARUSHION_SANDBOX_REPO") else {
            eprintln!("HARUSHION_SANDBOX_REPO 未設定のためスキップ");
            return;
        };

        // 準備: テスト用ラベル(存在してもエラーにしない)とサンドボックス Issue
        let _ = run_gh(GhInvocation {
            args: strs(&["label", "create", "e2e-test", "-R", &repo, "--force", "--color", "BFD4F2"]),
            stdin: None,
        })
        .await;
        let url = run_gh(GhInvocation {
            args: strs(&[
                "issue", "create", "-R", &repo,
                "--title", "[E2E] Harushion action roundtrip",
                "--body", "Harushion の操作経路 E2E テスト用に自動作成されました。自動でクローズされます。",
            ]),
            stdin: None,
        })
        .await
        .expect("issue create failed");
        assert!(url.starts_with("https://github.com/"), "unexpected create output: {url}");

        // 実装した操作経路を順に通す
        let run = |action: ItemAction, url: String| async move {
            let inv = build_invocation(&url, "issue", &action).expect("build failed");
            run_gh(inv).await
        };
        run(ItemAction::Comment { body: "E2E: コメント投稿テスト(stdin 経由)".into() }, url.clone())
            .await
            .expect("comment failed");
        run(ItemAction::EditLabels { add: vec!["e2e-test".into()], remove: vec![] }, url.clone())
            .await
            .expect("label add failed");
        run(ItemAction::AssignMe { remove: false }, url.clone())
            .await
            .expect("assign failed");
        run(ItemAction::Close, url.clone()).await.expect("close failed");
        run(ItemAction::Reopen, url.clone()).await.expect("reopen failed");
        run(ItemAction::Close, url.clone()).await.expect("re-close failed");

        // gh で最終状態を突合
        let state_json = run_gh(GhInvocation {
            args: strs(&["issue", "view", &url, "--json", "state,comments,labels,assignees"]),
            stdin: None,
        })
        .await
        .expect("view failed");
        let v: serde_json::Value = serde_json::from_str(&state_json).unwrap();
        assert_eq!(v["state"], "CLOSED");
        assert_eq!(v["comments"].as_array().unwrap().len(), 1);
        assert!(v["labels"].as_array().unwrap().iter().any(|l| l["name"] == "e2e-test"));
        assert!(!v["assignees"].as_array().unwrap().is_empty());

        // list_repo_labels の実経路も確認
        let labels = list_repo_labels(&repo).await.expect("label list failed");
        assert!(labels.iter().any(|l| l.name == "e2e-test"));

        // 後始末: 削除を試み、権限がなければクローズ済みのまま残す
        let deleted = run_gh(GhInvocation {
            args: strs(&["issue", "delete", &url, "--yes"]),
            stdin: None,
        })
        .await;
        if let Err(e) = deleted {
            eprintln!("issue delete は失敗(クローズ済みのまま残置): {e}");
        }
    }

    #[test]
    fn action_json_shape_matches_frontend_contract() {
        let a: ItemAction =
            serde_json::from_str(r#"{"type":"merge","method":"squash","deleteBranch":true}"#).unwrap();
        assert_eq!(a, ItemAction::Merge { method: "squash".into(), delete_branch: true });
        let a: ItemAction = serde_json::from_str(r#"{"type":"updateBranch"}"#).unwrap();
        assert_eq!(a, ItemAction::UpdateBranch);
        let a: ItemAction =
            serde_json::from_str(r#"{"type":"review","verdict":"requestChanges","body":"x"}"#).unwrap();
        assert_eq!(a, ItemAction::Review { verdict: "requestChanges".into(), body: Some("x".into()) });
        let a: ItemAction = serde_json::from_str(r#"{"type":"assignMe","remove":false}"#).unwrap();
        assert_eq!(a, ItemAction::AssignMe { remove: false });
        let a: ItemAction = serde_json::from_str(r#"{"type":"comment","body":"hi"}"#).unwrap();
        assert_eq!(a, ItemAction::Comment { body: "hi".into() });
        let a: ItemAction = serde_json::from_str(r#"{"type":"close"}"#).unwrap();
        assert_eq!(a, ItemAction::Close);
        let a: ItemAction = serde_json::from_str(r#"{"type":"reopen"}"#).unwrap();
        assert_eq!(a, ItemAction::Reopen);
        let a: ItemAction = serde_json::from_str(r#"{"type":"ready","undo":true}"#).unwrap();
        assert_eq!(a, ItemAction::Ready { undo: true });
        let a: ItemAction =
            serde_json::from_str(r#"{"type":"editLabels","add":["bug"],"remove":["wip"]}"#).unwrap();
        assert_eq!(a, ItemAction::EditLabels { add: vec!["bug".into()], remove: vec!["wip".into()] });
        let a: ItemAction =
            serde_json::from_str(r#"{"type":"editReviewers","add":["monalisa"],"remove":[]}"#).unwrap();
        assert_eq!(a, ItemAction::EditReviewers { add: vec!["monalisa".into()], remove: vec![] });
        let a: ItemAction = serde_json::from_str(
            r#"{"type":"setProjectStatus","itemId":"PVTI_x","projectId":"PVT_x","fieldId":"PVTSSF_x","optionId":"o1"}"#,
        )
        .unwrap();
        assert_eq!(
            a,
            ItemAction::SetProjectStatus {
                item_id: "PVTI_x".into(),
                project_id: "PVT_x".into(),
                field_id: "PVTSSF_x".into(),
                option_id: "o1".into(),
            }
        );
    }

    /// Finder/Dock 起動(launchd の最小 PATH)を模擬し、fix_path_env::fix() 後に
    /// gh が解決できることを検証する。gh が Homebrew 等の非標準 PATH にある
    /// ローカル環境が前提のためオプトイン(CI では走らせない)。
    /// PATH をプロセス全体で書き換え、並走中の他テストの gh 実行を壊すため、
    /// `cargo test -- --ignored` の一括実行では環境変数なしで即スキップさせ、
    /// 単独実行時のみ有効化する:
    /// `HARUSHION_PATH_TEST=1 cargo test path_fix -- --ignored`
    #[test]
    #[ignore = "rewrites process-wide PATH; opt-in via HARUSHION_PATH_TEST"]
    fn path_fix_resolves_gh_from_minimal_path() {
        if std::env::var("HARUSHION_PATH_TEST").is_err() {
            eprintln!("HARUSHION_PATH_TEST 未設定のためスキップ");
            return;
        }
        std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        let before = std::process::Command::new("gh").arg("--version").output();
        assert!(before.is_err(), "前提が不成立: 最小 PATH でも gh が見つかっています");
        fix_path_env::fix().expect("fix_path_env::fix() が失敗");
        let after = std::process::Command::new("gh").arg("--version").output();
        assert!(
            after.is_ok_and(|o| o.status.success()),
            "fix() 後も gh が解決できません"
        );
    }
}

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, UIEvent as ReactUIEvent } from "react";
import type { Item, ItemAction, ItemDetail, LabelInfo, MergeMethod, Viewer } from "../types";
import { relativeTime } from "./format";
import { StateBadge } from "./StateBadge";

type Props = {
  item: Item | null;
  detail: ItemDetail | null;
  loading: boolean;
  error: string | null;
  actionPending: boolean;
  pendingActionKey: string | null;
  viewer: Viewer | null;
  onAction: (action: ItemAction) => Promise<boolean>;
  onDismissError: () => void;
  onOpenUrl: (url: string) => void;
  onOpenInApp: (url: string) => void;
  onCopyUrl: (url: string) => Promise<void>;
  loadRepoLabels: (repo: string) => Promise<LabelInfo[]>;
};

function mergeableLabel(mergeable: string): string {
  if (mergeable === "MERGEABLE") return "マージ可能";
  if (mergeable === "CONFLICTING") return "コンフリクトあり";
  return "判定中";
}

function reviewDecisionLabel(decision: string): string {
  if (decision === "APPROVED") return "承認済み";
  if (decision === "CHANGES_REQUESTED") return "変更要求あり";
  if (decision === "REVIEW_REQUIRED") return "レビュー待ち";
  return decision;
}

function reviewStateLabel(state: string): string {
  switch (state) {
    case "APPROVED":
      return "承認";
    case "CHANGES_REQUESTED":
      return "変更要求";
    case "COMMENTED":
      return "コメント";
    case "DISMISSED":
      return "却下";
    case "PENDING":
      return "保留中";
    default:
      return state;
  }
}

function checkIconInfo(status: string): { char: string; className: string } {
  if (status === "SUCCESS" || status === "NEUTRAL" || status === "SKIPPED") {
    return { char: "✓", className: "check-success" };
  }
  if (
    status === "FAILURE" ||
    status === "ERROR" ||
    status === "TIMED_OUT" ||
    status === "CANCELLED" ||
    status === "ACTION_REQUIRED"
  ) {
    return { char: "✕", className: "check-failure" };
  }
  return { char: "●", className: "check-pending" };
}

function labelTextColor(hex: string): string {
  if (hex.length !== 6) return "#000000";
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

export function DetailPane({
  item,
  detail,
  loading,
  error,
  actionPending,
  pendingActionKey,
  viewer,
  onAction,
  onDismissError,
  onOpenUrl,
  onOpenInApp,
  onCopyUrl,
  loadRepoLabels,
}: Props) {
  const [commentText, setCommentText] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [repoLabelsList, setRepoLabelsList] = useState<LabelInfo[] | null>(null);
  const [checkedLabels, setCheckedLabels] = useState<Set<string>>(new Set());
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("squash");
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [propsGone, setPropsGone] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCommentText("");
    setReviewBody("");
    setLabelsOpen(false);
    setLabelsError(null);
    setConfirmClose(false);
    setConfirmMerge(false);
    setMergeMethod("squash");
    setDeleteBranch(false);
    // アイテム切替時はスクロール位置を先頭に戻す
    scrollRef.current?.scrollTo({ top: 0 });
    setScrolled(false);
    setPropsGone(false);
  }, [item?.url]);

  const handleScroll = (e: ReactUIEvent<HTMLDivElement>) => {
    setScrolled(e.currentTarget.scrollTop > 56);
    // プロパティ表がスティッキーバーの下に消えたら、凝縮版をバーに追加する
    const containerTop = e.currentTarget.getBoundingClientRect().top;
    const propsRect = propsRef.current?.getBoundingClientRect();
    setPropsGone(propsRect != null && propsRect.bottom <= containerTop + 8);
  };

  useEffect(() => {
    if (!labelsOpen && !confirmClose && !confirmMerge) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLabelsOpen(false);
        setConfirmClose(false);
        setConfirmMerge(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [labelsOpen, confirmClose, confirmMerge]);

  if (!item) {
    return (
      <div className="detail-pane detail-empty">
        <p className="empty">アイテムを選択してください</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="detail-pane detail-empty">
        {error ? (
          <div className="error detail-error">
            <p>{error}</p>
            <button className="btn" onClick={onDismissError}>
              閉じる
            </button>
          </div>
        ) : (
          <div className="spinner" />
        )}
      </div>
    );
  }

  const isAssignedToMe = viewer != null && detail.assignees.includes(viewer.login);
  const isPending = (key: string) => actionPending && pendingActionKey === key;
  const label = (base: string, key: string) => (isPending(key) ? `${base}中…` : base);

  const handleMdClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest("a");
    if (anchor) {
      const href = anchor.getAttribute("href");
      if (href) {
        e.preventDefault();
        onOpenUrl(anchor.href);
      }
    }
  };

  const openLabelsEditor = async () => {
    setLabelsOpen(true);
    setLabelsError(null);
    setCheckedLabels(new Set(detail.labels.map((l) => l.name)));
    setLabelsLoading(true);
    try {
      const list = await loadRepoLabels(detail.repo);
      setRepoLabelsList(list);
    } catch (e) {
      setLabelsError(String(e));
    } finally {
      setLabelsLoading(false);
    }
  };

  const toggleCheckedLabel = (name: string) => {
    setCheckedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const applyLabels = async () => {
    const current = new Set(detail.labels.map((l) => l.name));
    const add = [...checkedLabels].filter((n) => !current.has(n));
    const remove = [...current].filter((n) => !checkedLabels.has(n));
    if (add.length === 0 && remove.length === 0) {
      setLabelsOpen(false);
      return;
    }
    const ok = await onAction({ type: "editLabels", add, remove });
    if (ok) setLabelsOpen(false);
  };

  const handleAssignToggle = () => void onAction({ type: "assignMe", remove: isAssignedToMe });

  const handleSubmitComment = async () => {
    const body = commentText.trim();
    if (!body) return;
    const ok = await onAction({ type: "comment", body });
    if (ok) setCommentText("");
  };

  const handleReview = async (verdict: "approve" | "requestChanges" | "comment") => {
    const body = reviewBody.trim();
    if (verdict === "requestChanges" && !body) return;
    const ok = await onAction({ type: "review", verdict, body: body || null });
    if (ok) setReviewBody("");
  };

  const handleClose = async () => {
    const ok = await onAction({ type: "close" });
    if (ok) setConfirmClose(false);
  };

  const handleReopen = () => void onAction({ type: "reopen" });

  const handleMerge = async () => {
    const ok = await onAction({ type: "merge", method: mergeMethod, deleteBranch });
    if (ok) setConfirmMerge(false);
  };

  const handleReadyToggle = (undo: boolean) => void onAction({ type: "ready", undo });
  const handleUpdateBranch = () => void onAction({ type: "updateBranch" });

  const renderActionBar = () => {
    const buttons: React.ReactNode[] = [];

    if (detail.kind === "issue") {
      if (detail.state === "OPEN") {
        buttons.push(
          confirmClose ? (
            <span className="delete-confirm" key="close-confirm">
              <span className="delete-confirm-text">クローズしますか?</span>
              <button
                className="btn btn-danger"
                disabled={actionPending}
                onClick={() => void handleClose()}
              >
                {label("実行", "close")}
              </button>
              <button
                className="btn"
                disabled={actionPending}
                onClick={() => setConfirmClose(false)}
              >
                キャンセル
              </button>
            </span>
          ) : (
            <button
              key="close"
              className="btn"
              disabled={actionPending}
              onClick={() => setConfirmClose(true)}
            >
              クローズ
            </button>
          ),
        );
      } else {
        buttons.push(
          <button
            key="reopen"
            className="btn"
            disabled={actionPending}
            onClick={() => void handleReopen()}
          >
            {label("再オープン", "reopen")}
          </button>,
        );
      }
    } else {
      if (detail.state === "OPEN") {
        if (detail.isDraft) {
          buttons.push(
            <button
              key="ready"
              className="btn btn-primary"
              disabled={actionPending}
              onClick={() => handleReadyToggle(false)}
            >
              {label("レビュー準備完了", "ready:false")}
            </button>,
          );
        } else {
          buttons.push(
            <span className="merge-controls" key="merge">
              <select
                className="merge-method-select"
                value={mergeMethod}
                onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
                disabled={actionPending}
              >
                <option value="merge">Merge</option>
                <option value="squash">Squash</option>
                <option value="rebase">Rebase</option>
              </select>
              <label className="field-row-inline">
                <input
                  type="checkbox"
                  checked={deleteBranch}
                  onChange={(e) => setDeleteBranch(e.target.checked)}
                  disabled={actionPending}
                />
                ブランチ削除
              </label>
              {confirmMerge ? (
                <span className="delete-confirm">
                  <span className="delete-confirm-text">マージする?</span>
                  <button
                    className="btn btn-primary"
                    disabled={actionPending}
                    onClick={() => void handleMerge()}
                  >
                    {label("実行", "merge")}
                  </button>
                  <button
                    className="btn"
                    disabled={actionPending}
                    onClick={() => setConfirmMerge(false)}
                  >
                    キャンセル
                  </button>
                </span>
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={actionPending}
                  onClick={() => setConfirmMerge(true)}
                >
                  マージ
                </button>
              )}
            </span>,
          );
          buttons.push(
            <span className="review-controls" key="review">
              <input
                type="text"
                className="review-body-input"
                placeholder="レビューコメント (任意)"
                value={reviewBody}
                onChange={(e) => setReviewBody(e.target.value)}
                disabled={actionPending}
              />
              <button
                className="btn"
                disabled={actionPending}
                onClick={() => void handleReview("approve")}
              >
                {label("Approve", "review:approve")}
              </button>
              <button
                className="btn"
                disabled={actionPending || reviewBody.trim().length === 0}
                title={reviewBody.trim().length === 0 ? "コメントを入力してください" : undefined}
                onClick={() => void handleReview("requestChanges")}
              >
                {label("変更をリクエスト", "review:requestChanges")}
              </button>
              <button
                className="btn"
                disabled={actionPending}
                onClick={() => void handleReview("comment")}
              >
                {label("コメント", "review:comment")}
              </button>
            </span>,
          );
          buttons.push(
            <button
              key="ready-undo"
              className="btn"
              disabled={actionPending}
              onClick={() => handleReadyToggle(true)}
            >
              {label("ドラフトに戻す", "ready:true")}
            </button>,
          );
          buttons.push(
            <button
              key="update-branch"
              className="btn"
              disabled={actionPending}
              onClick={() => handleUpdateBranch()}
            >
              {label("ブランチ更新", "updateBranch")}
            </button>,
          );
        }
      } else if (detail.state === "CLOSED") {
        buttons.push(
          <button
            key="reopen"
            className="btn"
            disabled={actionPending}
            onClick={() => void handleReopen()}
          >
            {label("再オープン", "reopen")}
          </button>,
        );
      }
    }

    if (buttons.length === 0) return null;
    return <div className="action-bar">{buttons}</div>;
  };

  const actionBar = renderActionBar();

  return (
    <div className="detail-pane">
      <div className="detail-scroll" ref={scrollRef} onScroll={handleScroll}>
        <header className="detail-header">
          <div className="detail-eyebrow">
            <span className="detail-repo">{detail.repo}</span>
            <span className="detail-number">#{detail.number}</span>
            <span className="detail-eyebrow-spacer" />
            <button
              className="btn btn-small"
              onClick={() => {
                void onCopyUrl(detail.url).then(() => {
                  setUrlCopied(true);
                  setTimeout(() => setUrlCopied(false), 1500);
                });
              }}
            >
              {urlCopied ? "コピーしました" : "URLをコピー"}
            </button>
            <button className="btn btn-small" onClick={() => onOpenInApp(detail.url)}>
              アプリ内で開く
            </button>
            <button className="btn btn-small" onClick={() => onOpenUrl(detail.url)}>
              ブラウザで開く
            </button>
          </div>
          <button className="detail-title-link" onClick={() => onOpenUrl(detail.url)}>
            {detail.title}
          </button>
          <div className="detail-header-meta">
            <StateBadge
              kind={detail.kind}
              state={detail.state}
              isDraft={detail.isDraft}
              size={14}
            />
            {detail.authorAvatar && (
              <img src={detail.authorAvatar} className="avatar avatar-small" alt="" />
            )}
            {detail.author && <span className="detail-author">{detail.author}</span>}
            <span className="detail-time">
              作成 {relativeTime(detail.createdAt)} · 更新 {relativeTime(detail.updatedAt)}
            </span>
            {detail.milestone && <span className="milestone-chip">🎯 {detail.milestone}</span>}
          </div>
        </header>

        {(actionBar || scrolled) && (
          <div className="detail-sticky">
            {scrolled && (
              <div className="detail-sticky-title">
                <StateBadge
                  kind={detail.kind}
                  state={detail.state}
                  isDraft={detail.isDraft}
                  size={14}
                />
                <span className="detail-sticky-repo">
                  {detail.repo}#{detail.number}
                </span>
                <span className="detail-sticky-title-text">{detail.title}</span>
              </div>
            )}
            {propsGone && (
              <div className="detail-sticky-props">
                {detail.kind === "pr" && (
                  <>
                    <span className="pr-branches">
                      <code>{detail.baseRef}</code> ← <code>{detail.headRef}</code>
                    </span>
                    <span className="pr-diffstat">
                      <span className="pr-additions">+{detail.additions}</span>{" "}
                      <span className="pr-deletions">-{detail.deletions}</span>
                    </span>
                    {detail.mergeable === "CONFLICTING" && (
                      <span className="mergeable-badge warn">
                        {mergeableLabel(detail.mergeable)}
                      </span>
                    )}
                    {detail.reviewDecision && (
                      <span
                        className={`review-decision-badge rd-${detail.reviewDecision.toLowerCase()}`}
                      >
                        {reviewDecisionLabel(detail.reviewDecision)}
                      </span>
                    )}
                  </>
                )}
                {detail.labels.slice(0, 4).map((l) => (
                  <span
                    key={l.name}
                    className="label-chip label-chip-small"
                    style={{ background: `#${l.color}`, color: labelTextColor(l.color) }}
                  >
                    {l.name}
                  </span>
                ))}
                {detail.labels.length > 4 && (
                  <span className="fg-muted">+{detail.labels.length - 4}</span>
                )}
              </div>
            )}
            {actionBar}
          </div>
        )}

        <div className="detail-props" ref={propsRef}>
          {detail.kind === "pr" && (
            <div className="prop-row">
              <span className="prop-label">ブランチ</span>
              <div className="prop-value pr-info">
                <span className="pr-branches">
                  <code>{detail.baseRef}</code> ← <code>{detail.headRef}</code>
                </span>
                <span className="pr-diffstat">
                  <span className="pr-additions">+{detail.additions}</span>{" "}
                  <span className="pr-deletions">-{detail.deletions}</span>{" "}
                  <span className="pr-changed-files">{detail.changedFiles} files</span>
                </span>
                {detail.mergeable && (
                  <span
                    className={`mergeable-badge${detail.mergeable === "CONFLICTING" ? " warn" : ""}`}
                  >
                    {mergeableLabel(detail.mergeable)}
                  </span>
                )}
                {detail.reviewDecision && (
                  <span
                    className={`review-decision-badge rd-${detail.reviewDecision.toLowerCase()}`}
                  >
                    {reviewDecisionLabel(detail.reviewDecision)}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="prop-row">
            <span className="prop-label">ラベル</span>
            <div className="prop-value labels-row">
              {detail.labels.map((l) => (
                <span
                  key={l.name}
                  className="label-chip"
                  style={{ background: `#${l.color}`, color: labelTextColor(l.color) }}
                >
                  {l.name}
                </span>
              ))}
              <button className="label-edit-btn" onClick={() => void openLabelsEditor()}>
                編集
              </button>
              {labelsOpen && (
                <div className="popover labels-popover">
                  {labelsLoading && <p className="popover-loading">読み込み中…</p>}
                  {labelsError && <p className="popover-error">{labelsError}</p>}
                  {!labelsLoading && repoLabelsList && (
                    <>
                      <div className="labels-popover-list">
                        {repoLabelsList.map((l) => (
                          <label key={l.name} className="labels-popover-item">
                            <input
                              type="checkbox"
                              checked={checkedLabels.has(l.name)}
                              onChange={() => toggleCheckedLabel(l.name)}
                            />
                            <span
                              className="label-chip label-chip-small"
                              style={{ background: `#${l.color}`, color: labelTextColor(l.color) }}
                            >
                              {l.name}
                            </span>
                          </label>
                        ))}
                        {repoLabelsList.length === 0 && (
                          <p className="popover-empty">ラベルがありません</p>
                        )}
                      </div>
                      <div className="popover-actions">
                        <button
                          className="btn"
                          onClick={() => setLabelsOpen(false)}
                          disabled={actionPending}
                        >
                          キャンセル
                        </button>
                        <button
                          className="btn btn-primary"
                          onClick={() => void applyLabels()}
                          disabled={actionPending}
                        >
                          {label("適用", "editLabels")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="prop-row">
            <span className="prop-label">担当</span>
            <div className="prop-value assignees-row">
              {detail.assignees.length === 0 && <span className="fg-muted">なし</span>}
              {detail.assignees.map((a) => (
                <span key={a} className="assignee-chip">
                  {a}
                </span>
              ))}
              {viewer && (
                <button
                  className="btn btn-small"
                  onClick={handleAssignToggle}
                  disabled={actionPending}
                >
                  {isAssignedToMe
                    ? label("アサイン解除", "assignMe")
                    : label("自分をアサイン", "assignMe")}
                </button>
              )}
            </div>
          </div>

          {detail.kind === "pr" && detail.checks.length > 0 && (
            <div className="prop-row">
              <span className="prop-label">チェック</span>
              <div className="prop-value prop-value-stack">
                {detail.checks.map((c, i) => {
                  const icon = checkIconInfo(c.status);
                  return (
                    <div
                      key={`${c.name}-${i}`}
                      className={`check-row${c.url ? " clickable" : ""}`}
                      onClick={() => c.url && onOpenUrl(c.url)}
                    >
                      <span className={`check-icon ${icon.className}`}>{icon.char}</span>
                      <span className="check-name">{c.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {detail.kind === "pr" && detail.reviews.length > 0 && (
            <div className="prop-row">
              <span className="prop-label">レビュー</span>
              <div className="prop-value prop-value-stack">
                {detail.reviews.map((r, i) => (
                  <div key={`${r.author}-${i}`} className="review-row">
                    <span className="review-author">{r.author ?? "unknown"}</span>
                    <span className={`review-state-badge rs-${r.state.toLowerCase()}`}>
                      {reviewStateLabel(r.state)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="error detail-error">
            <p>{error}</p>
            <button className="btn" onClick={onDismissError}>
              閉じる
            </button>
          </div>
        )}
        {loading && <div className="detail-loading-bar" />}

        <section className="detail-body-section">
          {detail.bodyHtml ? (
            <div
              className="md"
              onClick={handleMdClick}
              dangerouslySetInnerHTML={{ __html: detail.bodyHtml }}
            />
          ) : (
            <p className="fg-muted">本文なし</p>
          )}
        </section>

        <section className="comments-section">
          <h3 className="detail-section-title">
            コメント{detail.commentsTotal > 0 && ` (${detail.commentsTotal})`}
          </h3>
          {detail.commentsTotal > detail.comments.length && (
            <p className="comments-hint">
              他{detail.commentsTotal - detail.comments.length}件のコメント
            </p>
          )}
          {detail.comments.map((c, i) => (
            <article className="comment-card" key={i}>
              <div className="comment-header">
                {c.authorAvatar && (
                  <img src={c.authorAvatar} className="avatar avatar-small" alt="" />
                )}
                <span className="comment-author">{c.author ?? "unknown"}</span>
                <span className="comment-time">{relativeTime(c.createdAt)}</span>
              </div>
              <div
                className="md comment-body"
                onClick={handleMdClick}
                dangerouslySetInnerHTML={{ __html: c.bodyHtml }}
              />
            </article>
          ))}
        </section>

        <div className="comment-composer">
          <textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="コメントを書く…"
            disabled={actionPending}
          />
          <button
            className="btn btn-primary"
            disabled={actionPending || commentText.trim().length === 0}
            onClick={() => void handleSubmitComment()}
          >
            {label("送信", "comment")}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode, UIEvent as ReactUIEvent } from "react";
import type {
  Epic,
  Item,
  ItemAction,
  ItemDetail,
  LabelInfo,
  MergeMethod,
  RelatedItem,
  Viewer,
} from "../types";
import { relativeTime } from "./format";
import { Octicon, resolveState, StateBadge } from "./StateBadge";
import { useI18n } from "../i18n";
import type { MessagePath, TFunction } from "../i18n";

type Props = {
  item: Item | null;
  detail: ItemDetail | null;
  loading: boolean;
  error: string | null;
  actionPending: boolean;
  pendingActionKey: string | null;
  viewer: Viewer | null;
  epics: Epic[];
  itemEpicIds: number[];
  onAddToEpic: (epicId: number) => void;
  onRemoveFromEpic: (epicId: number) => void;
  onAction: (action: ItemAction) => Promise<boolean>;
  onDismissError: () => void;
  onOpenUrl: (url: string) => void;
  onOpenInApp: (url: string) => void;
  onCopyUrl: (url: string) => Promise<void>;
  onSelectRelated: (related: RelatedItem) => void;
  loadRepoLabels: (repo: string) => Promise<LabelInfo[]>;
  loadReviewerCandidates: (repo: string) => Promise<string[]>;
};

function mergeableLabel(t: TFunction, mergeable: string): string {
  if (mergeable === "MERGEABLE") return t("detail.mergeable.mergeable");
  if (mergeable === "CONFLICTING") return t("detail.mergeable.conflicting");
  return t("detail.mergeable.pending");
}

function reviewDecisionLabel(t: TFunction, decision: string): string {
  if (decision === "APPROVED") return t("detail.reviewDecision.approved");
  if (decision === "CHANGES_REQUESTED") return t("detail.reviewDecision.changesRequested");
  if (decision === "REVIEW_REQUIRED") return t("detail.reviewDecision.reviewRequired");
  return decision;
}

function reviewStateLabel(t: TFunction, state: string): string {
  switch (state) {
    case "APPROVED":
      return t("detail.reviewState.approved");
    case "CHANGES_REQUESTED":
      return t("detail.reviewState.changesRequested");
    case "COMMENTED":
      return t("detail.reviewState.commented");
    case "DISMISSED":
      return t("detail.reviewState.dismissed");
    case "PENDING":
      return t("detail.reviewState.pending");
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

/** GitHub の状態ピル(Open/Closed/Merged/Draft を塗りつぶし色+アイコンで) */
function StatePill({
  kind,
  state,
  isDraft,
}: {
  kind: "issue" | "pr";
  state: string;
  isDraft: boolean;
}) {
  const { icon, label: stateLabel, color } = resolveState(kind, state, isDraft);
  return (
    <span className={`state-pill ${color}`}>
      <Octicon paths={icon} size={14} />
      {stateLabel}
    </span>
  );
}

/** サイドバーの各セクション共通の外枠(見出し付き) */
function SidebarSection({
  title,
  className,
  children,
}: {
  title: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <section className={`sidebar-section ${className}`}>
      <h4 className="sidebar-section-title">{title}</h4>
      {children}
    </section>
  );
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
  epics,
  itemEpicIds,
  onAddToEpic,
  onRemoveFromEpic,
  onAction,
  onDismissError,
  onOpenUrl,
  onOpenInApp,
  onCopyUrl,
  onSelectRelated,
  loadRepoLabels,
  loadReviewerCandidates,
}: Props) {
  const { t } = useI18n();
  const [commentText, setCommentText] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [repoLabelsList, setRepoLabelsList] = useState<LabelInfo[] | null>(null);
  const [checkedLabels, setCheckedLabels] = useState<Set<string>>(new Set());
  const [reviewerCandidates, setReviewerCandidates] = useState<string[]>([]);
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

  // レビュワー追加ドロップダウンの候補。リポジトリ単位で親がキャッシュするので
  // PR を開くたびの再取得にはならない。取得失敗は候補なし(追加 UI 非表示)に落とす
  const detailRepo = detail?.kind === "pr" ? detail.repo : null;
  useEffect(() => {
    setReviewerCandidates([]);
    if (!detailRepo) return;
    let cancelled = false;
    loadReviewerCandidates(detailRepo)
      .then((list) => {
        if (!cancelled) setReviewerCandidates(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [detailRepo, loadReviewerCandidates]);

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
        <p className="empty">{t("detail.selectItem")}</p>
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
              {t("common.close")}
            </button>
          </div>
        ) : (
          <div className="spinner" />
        )}
      </div>
    );
  }

  const isAssignedToMe = viewer != null && detail.assignees.includes(viewer.login);
  // closed/merged PR へのレビュー依頼変更は GitHub が拒否するため、操作系は OPEN 限定
  const isOpen = detail.state === "OPEN";
  // 作者と依頼済みの相手は追加候補から除く(作者へのレビュー依頼は GitHub が拒否する)
  const requestedReviewers = new Set(detail.reviewRequests);
  const addableReviewers = reviewerCandidates.filter(
    (l) => l !== detail.author && !requestedReviewers.has(l),
  );
  // アーカイブ済みエピックは追加候補に出さない(既所属チップからの削除は残す)
  const addableEpics = epics.filter((e) => !itemEpicIds.includes(e.id) && !e.archived);
  const isPending = (key: string) => actionPending && pendingActionKey === key;
  const label = (baseKey: MessagePath, key: string) => {
    const base = t(baseKey);
    return isPending(key) ? t("common.pending", { action: base }) : base;
  };

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

  // GitHub の「Close issue / Reopen」相当。コメント送信ボタンの隣に置く
  const renderCloseReopen = () => {
    if (detail.state === "MERGED") return null;
    if (detail.state !== "OPEN") {
      return (
        <button className="btn" disabled={actionPending} onClick={() => void handleReopen()}>
          {label("detail.reopen", "reopen")}
        </button>
      );
    }
    return confirmClose ? (
      <span className="delete-confirm">
        <span className="delete-confirm-text">{t("detail.closeConfirm")}</span>
        <button
          className="btn btn-danger"
          disabled={actionPending}
          onClick={() => void handleClose()}
        >
          {label("detail.confirmRun", "close")}
        </button>
        <button className="btn" disabled={actionPending} onClick={() => setConfirmClose(false)}>
          {t("common.cancel")}
        </button>
      </span>
    ) : (
      <button className="btn" disabled={actionPending} onClick={() => setConfirmClose(true)}>
        {t("detail.closeIssue")}
      </button>
    );
  };

  // GitHub のマージボックス相当。タイムライン末尾に置き、
  // チェック・レビュー判定・マージ可否のまとめとマージ/レビュー操作を集約する
  const renderMergeBox = () => {
    if (detail.kind !== "pr") return null;
    const open = detail.state === "OPEN";
    // closed/merged でもレビュー判定(Approved 等)は履歴として見せる。
    // チェックも判定も無いときだけ箱ごと省略する
    if (!open && detail.checks.length === 0 && !detail.reviewDecision) return null;
    return (
      <div className="merge-box">
        {(detail.reviewDecision || (open && detail.mergeable)) && (
          <div className="merge-box-row merge-box-status">
            {detail.reviewDecision && (
              <span className={`review-decision-badge rd-${detail.reviewDecision.toLowerCase()}`}>
                {reviewDecisionLabel(t, detail.reviewDecision)}
              </span>
            )}
            {open && detail.mergeable && (
              <span
                className={`mergeable-badge${detail.mergeable === "CONFLICTING" ? " warn" : ""}`}
              >
                {mergeableLabel(t, detail.mergeable)}
              </span>
            )}
          </div>
        )}
        {detail.checks.length > 0 && (
          <div className="merge-box-row merge-box-checks">
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
        )}
        {open && detail.isDraft && (
          <div className="merge-box-row merge-box-actions">
            <button
              className="btn btn-primary"
              disabled={actionPending}
              onClick={() => handleReadyToggle(false)}
            >
              {label("detail.readyForReview", "ready:false")}
            </button>
          </div>
        )}
        {open && !detail.isDraft && (
          <>
            <div className="merge-box-row merge-box-actions">
              <span className="merge-controls">
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
                  {t("detail.deleteBranch")}
                </label>
                {confirmMerge ? (
                  <span className="delete-confirm">
                    <span className="delete-confirm-text">{t("detail.mergeConfirm")}</span>
                    <button
                      className="btn btn-primary"
                      disabled={actionPending}
                      onClick={() => void handleMerge()}
                    >
                      {label("detail.confirmRun", "merge")}
                    </button>
                    <button
                      className="btn"
                      disabled={actionPending}
                      onClick={() => setConfirmMerge(false)}
                    >
                      {t("common.cancel")}
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn btn-primary"
                    disabled={actionPending}
                    onClick={() => setConfirmMerge(true)}
                  >
                    {t("detail.mergeButton")}
                  </button>
                )}
              </span>
              <button
                className="btn"
                disabled={actionPending}
                onClick={() => handleReadyToggle(true)}
              >
                {label("detail.convertToDraft", "ready:true")}
              </button>
              <button className="btn" disabled={actionPending} onClick={() => handleUpdateBranch()}>
                {label("detail.updateBranch", "updateBranch")}
              </button>
            </div>
            <div className="merge-box-row merge-box-actions">
              <span className="review-controls">
                <input
                  type="text"
                  className="review-body-input"
                  placeholder={t("detail.reviewCommentPlaceholder")}
                  value={reviewBody}
                  onChange={(e) => setReviewBody(e.target.value)}
                  disabled={actionPending}
                />
                <button
                  className="btn"
                  disabled={actionPending}
                  onClick={() => void handleReview("approve")}
                >
                  {label("detail.approve", "review:approve")}
                </button>
                <button
                  className="btn"
                  disabled={actionPending || reviewBody.trim().length === 0}
                  title={
                    reviewBody.trim().length === 0 ? t("detail.requestChangesTitle") : undefined
                  }
                  onClick={() => void handleReview("requestChanges")}
                >
                  {label("detail.requestChanges", "review:requestChanges")}
                </button>
                <button
                  className="btn"
                  disabled={actionPending}
                  onClick={() => void handleReview("comment")}
                >
                  {label("detail.reviewComment", "review:comment")}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    );
  };

  // URL コピー/アプリで開く/ブラウザで開く。通常ヘッダーとスティッキーバーの両方に出す
  const urlActions = (
    <>
      <button
        className="btn btn-small"
        onClick={() => {
          void onCopyUrl(detail.url).then(() => {
            setUrlCopied(true);
            setTimeout(() => setUrlCopied(false), 1500);
          });
        }}
      >
        {urlCopied ? t("detail.copied") : t("detail.copyUrl")}
      </button>
      <button className="btn btn-small" onClick={() => onOpenInApp(detail.url)}>
        {t("detail.openInApp")}
      </button>
      <button className="btn btn-small" onClick={() => onOpenUrl(detail.url)}>
        {t("detail.openInBrowser")}
      </button>
    </>
  );

  return (
    <div className="detail-pane">
      <div className="detail-scroll" ref={scrollRef} onScroll={handleScroll}>
        <header className="detail-header" ref={propsRef}>
          <div className="detail-eyebrow">
            <span className="detail-repo">{detail.repo}</span>
            <span className="detail-eyebrow-spacer" />
            {urlActions}
          </div>
          <button className="detail-title-link" onClick={() => onOpenUrl(detail.url)}>
            {detail.title} <span className="detail-title-number">#{detail.number}</span>
          </button>
          <div className="detail-header-meta">
            <StatePill kind={detail.kind} state={detail.state} isDraft={detail.isDraft} />
            {detail.authorAvatar && (
              <img src={detail.authorAvatar} className="avatar avatar-small" alt="" />
            )}
            {detail.author && <span className="detail-author">{detail.author}</span>}
            <span className="detail-time">
              {t("detail.createdUpdated", {
                created: relativeTime(detail.createdAt),
                updated: relativeTime(detail.updatedAt),
              })}
            </span>
            {detail.kind === "pr" && (
              <>
                <span className="pr-branches">
                  <code>{detail.baseRef}</code> ← <code>{detail.headRef}</code>
                </span>
                <span className="pr-diffstat">
                  <span className="pr-additions">+{detail.additions}</span>{" "}
                  <span className="pr-deletions">-{detail.deletions}</span>{" "}
                  <span className="pr-changed-files">
                    {t("detail.changedFiles", { n: detail.changedFiles })}
                  </span>
                </span>
              </>
            )}
          </div>
        </header>

        {scrolled && (
          <div className="detail-sticky">
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
              <span className="detail-sticky-actions">{urlActions}</span>
            </div>
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
                    {isOpen && detail.mergeable === "CONFLICTING" && (
                      <span className="mergeable-badge warn">
                        {mergeableLabel(t, detail.mergeable)}
                      </span>
                    )}
                    {detail.reviewDecision && (
                      <span
                        className={`review-decision-badge rd-${detail.reviewDecision.toLowerCase()}`}
                      >
                        {reviewDecisionLabel(t, detail.reviewDecision)}
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
          </div>
        )}

        {error && (
          <div className="error detail-error">
            <p>{error}</p>
            <button className="btn" onClick={onDismissError}>
              {t("common.close")}
            </button>
          </div>
        )}
        {loading && <div className="detail-loading-bar" />}

        <div className="detail-columns">
          <aside className="detail-sidebar">
            {detail.kind === "pr" &&
              (detail.reviews.length > 0 ||
                detail.reviewRequests.length > 0 ||
                (isOpen && addableReviewers.length > 0)) && (
                <SidebarSection title={t("detail.reviews")} className="sec-reviewers">
                  <div className="sidebar-stack">
                    {detail.reviews.map((r, i) => (
                      <div key={`${r.author}-${i}`} className="review-row">
                        <span className="review-author">{r.author ?? "unknown"}</span>
                        <span className={`review-state-badge rs-${r.state.toLowerCase()}`}>
                          {reviewStateLabel(t, r.state)}
                        </span>
                      </div>
                    ))}
                    {detail.reviewRequests.map((login) => (
                      <div key={login} className="review-row">
                        <span className="review-author">{login}</span>
                        <span className="review-state-badge rs-requested">
                          {t("detail.reviewRequested")}
                        </span>
                        {isOpen && (
                          <button
                            type="button"
                            className="chip-remove"
                            disabled={actionPending}
                            onClick={() =>
                              void onAction({ type: "editReviewers", add: [], remove: [login] })
                            }
                            aria-label={t("detail.removeReviewer", { name: login })}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                    {isOpen && addableReviewers.length > 0 && (
                      <select
                        className="epic-add-select"
                        value=""
                        disabled={actionPending}
                        onChange={(e) => {
                          const login = e.target.value;
                          if (login) {
                            void onAction({ type: "editReviewers", add: [login], remove: [] });
                          }
                        }}
                      >
                        <option value="">{t("detail.addReviewer")}</option>
                        {addableReviewers.map((login) => (
                          <option key={login} value={login}>
                            {login}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </SidebarSection>
              )}

            <SidebarSection title={t("detail.assignees")} className="sec-assignees">
              <div className="assignees-row">
                {detail.assignees.length === 0 && (
                  <span className="fg-muted">{t("common.none")}</span>
                )}
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
                      ? label("detail.unassign", "assignMe")
                      : label("detail.assignMe", "assignMe")}
                  </button>
                )}
              </div>
            </SidebarSection>

            <SidebarSection title={t("detail.labels")} className="sec-labels">
              <div className="labels-row">
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
                  {t("common.edit")}
                </button>
                {labelsOpen && (
                  <div className="popover labels-popover">
                    {labelsLoading && <p className="popover-loading">{t("common.loading")}</p>}
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
                                style={{
                                  background: `#${l.color}`,
                                  color: labelTextColor(l.color),
                                }}
                              >
                                {l.name}
                              </span>
                            </label>
                          ))}
                          {repoLabelsList.length === 0 && (
                            <p className="popover-empty">{t("detail.noLabels")}</p>
                          )}
                        </div>
                        <div className="popover-actions">
                          <button
                            className="btn"
                            onClick={() => setLabelsOpen(false)}
                            disabled={actionPending}
                          >
                            {t("common.cancel")}
                          </button>
                          <button
                            className="btn btn-primary"
                            onClick={() => void applyLabels()}
                            disabled={actionPending}
                          >
                            {label("detail.applyLabels", "editLabels")}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </SidebarSection>

            {detail.milestone && (
              <SidebarSection title={t("detail.milestoneLabel")} className="sec-milestone">
                <span className="fg-muted">{detail.milestone}</span>
              </SidebarSection>
            )}

            {(detail.projects.length > 0 || detail.projectsScopeMissing) && (
              <SidebarSection title={t("detail.projects")} className="sec-projects">
                <div className="sidebar-stack">
                  {detail.projectsScopeMissing && (
                    <span className="fg-muted">{t("detail.projectsScopeHint")}</span>
                  )}
                  {detail.projects.map((p) => {
                    const fieldId = p.statusFieldId;
                    return (
                      <div key={p.itemId} className="project-row">
                        <button
                          className="project-link"
                          title={p.url}
                          onClick={() => onOpenUrl(p.url)}
                        >
                          {p.title}
                        </button>
                        {fieldId != null && p.statusOptions.length > 0 ? (
                          <select
                            className="epic-add-select"
                            value={p.statusOptionId ?? ""}
                            disabled={actionPending}
                            onChange={(e) => {
                              const optionId = e.target.value;
                              if (optionId && optionId !== p.statusOptionId) {
                                void onAction({
                                  type: "setProjectStatus",
                                  itemId: p.itemId,
                                  projectId: p.projectId,
                                  fieldId,
                                  optionId,
                                });
                              }
                            }}
                          >
                            {p.statusOptionId == null && (
                              <option value="">{t("detail.noStatus")}</option>
                            )}
                            {p.statusOptions.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          p.status && <span className="fg-muted">{p.status}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </SidebarSection>
            )}

            {detail.related.length > 0 && (
              <SidebarSection title={t("detail.related")} className="sec-development">
                <div className="related-list">
                  {detail.related.map((r) => (
                    <button
                      key={r.url}
                      className="related-item"
                      title={r.url}
                      onClick={() => onSelectRelated(r)}
                    >
                      <StateBadge kind={r.kind} state={r.state} isDraft={r.isDraft} size={14} />
                      <span className="related-ref">
                        {r.repo !== detail.repo && r.repo}#{r.number}
                      </span>
                      <span className="related-title">{r.title}</span>
                    </button>
                  ))}
                  {detail.relatedTotal > detail.related.length && (
                    <span className="fg-muted">+{detail.relatedTotal - detail.related.length}</span>
                  )}
                </div>
              </SidebarSection>
            )}

            <SidebarSection title={t("detail.epics")} className="sec-epics">
              <div className="epics-row">
                {epics.length === 0 && <span className="fg-muted">{t("detail.noEpicsHint")}</span>}
                {epics
                  .filter((e) => itemEpicIds.includes(e.id))
                  .map((e) => (
                    <span
                      key={e.id}
                      className="epic-chip"
                      style={
                        e.color ? { borderColor: `#${e.color}`, color: `#${e.color}` } : undefined
                      }
                    >
                      {e.name}
                      <button
                        type="button"
                        className="chip-remove"
                        onClick={() => onRemoveFromEpic(e.id)}
                        aria-label={t("detail.removeFromEpic", { name: e.name })}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                {addableEpics.length > 0 && (
                  <select
                    className="epic-add-select"
                    value=""
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      if (id) onAddToEpic(id);
                    }}
                  >
                    <option value="">{t("detail.addToEpic")}</option>
                    {addableEpics.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </SidebarSection>
          </aside>

          <div className="detail-main">
            <section className="comments-section">
              <article className="comment-card">
                <div className="comment-header">
                  {detail.authorAvatar && (
                    <img src={detail.authorAvatar} className="avatar avatar-small" alt="" />
                  )}
                  <span className="comment-author">{detail.author ?? "unknown"}</span>
                  <span className="comment-time">{relativeTime(detail.createdAt)}</span>
                </div>
                <div className="comment-body">
                  {detail.bodyHtml ? (
                    <div
                      className="md"
                      onClick={handleMdClick}
                      dangerouslySetInnerHTML={{ __html: detail.bodyHtml }}
                    />
                  ) : (
                    <p className="fg-muted">{t("detail.noBody")}</p>
                  )}
                </div>
              </article>
              {detail.timelineTotal > detail.timeline.length && (
                <p className="comments-hint">
                  {t("detail.moreTimeline", { n: detail.timelineTotal - detail.timeline.length })}
                </p>
              )}
              {detail.timeline.map((e, i) =>
                e.kind === "comment" ? (
                  <article className="comment-card" key={i}>
                    <div className="comment-header">
                      {e.authorAvatar && (
                        <img src={e.authorAvatar} className="avatar avatar-small" alt="" />
                      )}
                      <span className="comment-author">{e.author ?? "unknown"}</span>
                      <span className="comment-time">{relativeTime(e.createdAt)}</span>
                    </div>
                    <div
                      className="md comment-body"
                      onClick={handleMdClick}
                      dangerouslySetInnerHTML={{ __html: e.bodyHtml }}
                    />
                  </article>
                ) : e.kind === "commit" ? (
                  <div key={i} className="commit-row" onClick={() => onOpenUrl(e.url)}>
                    {e.authorAvatar ? (
                      <img src={e.authorAvatar} className="avatar avatar-small" alt="" />
                    ) : (
                      <span className="avatar avatar-small avatar-placeholder" />
                    )}
                    <span className="commit-message" title={e.message}>
                      {e.message}
                    </span>
                    <span className="commit-author">{e.author ?? "unknown"}</span>
                    <code className="commit-oid">{e.shortOid}</code>
                    <span className="commit-time">{relativeTime(e.date)}</span>
                  </div>
                ) : e.kind === "review" ? (
                  e.bodyHtml ? (
                    <article className="comment-card" key={i}>
                      <div className="comment-header">
                        {e.authorAvatar && (
                          <img src={e.authorAvatar} className="avatar avatar-small" alt="" />
                        )}
                        <span className="comment-author">{e.author ?? "unknown"}</span>
                        <span className={`review-state-badge rs-${e.state.toLowerCase()}`}>
                          {reviewStateLabel(t, e.state)}
                        </span>
                        <span className="comment-time">{relativeTime(e.createdAt)}</span>
                      </div>
                      <div
                        className="md comment-body"
                        onClick={handleMdClick}
                        dangerouslySetInnerHTML={{ __html: e.bodyHtml }}
                      />
                    </article>
                  ) : (
                    // 本文なし(承認のみ・インラインコメントのみ)は状態バッジだけの行
                    <div key={i} className="review-event-row">
                      {e.authorAvatar ? (
                        <img src={e.authorAvatar} className="avatar avatar-small" alt="" />
                      ) : (
                        <span className="avatar avatar-small avatar-placeholder" />
                      )}
                      <span className="commit-author">{e.author ?? "unknown"}</span>
                      <span className={`review-state-badge rs-${e.state.toLowerCase()}`}>
                        {reviewStateLabel(t, e.state)}
                      </span>
                      <span className="commit-time">{relativeTime(e.createdAt)}</span>
                    </div>
                  )
                ) : (
                  <button
                    key={i}
                    type="button"
                    className="timeline-ref-row"
                    title={e.url}
                    onClick={() =>
                      onSelectRelated({
                        kind: "pr",
                        number: e.number,
                        title: e.title,
                        url: e.url,
                        state: e.state,
                        isDraft: e.isDraft,
                        repo: e.repo,
                      })
                    }
                  >
                    <StateBadge kind="pr" state={e.state} isDraft={e.isDraft} size={14} />
                    <span className="related-ref">
                      {e.repo !== detail.repo && e.repo}#{e.number}
                    </span>
                    <span className="related-title">{e.title}</span>
                    <span className="timeline-ref-note">
                      {t("detail.timelineLinkedPr", { actor: e.actor ?? "unknown" })}
                    </span>
                    <span className="commit-time">{relativeTime(e.createdAt)}</span>
                  </button>
                ),
              )}
            </section>

            {renderMergeBox()}

            <div className="comment-composer">
              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder={t("detail.commentPlaceholder")}
                disabled={actionPending}
              />
              <div className="composer-actions">
                {renderCloseReopen()}
                <button
                  className="btn btn-primary"
                  disabled={actionPending || commentText.trim().length === 0}
                  onClick={() => void handleSubmitComment()}
                >
                  {label("detail.send", "comment")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

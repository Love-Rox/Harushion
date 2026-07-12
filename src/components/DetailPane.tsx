import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, UIEvent as ReactUIEvent } from "react";
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
import { StateBadge } from "./StateBadge";
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
}: Props) {
  const { t } = useI18n();
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

  const renderActionBar = () => {
    const buttons: React.ReactNode[] = [];

    if (detail.kind === "issue") {
      if (detail.state === "OPEN") {
        buttons.push(
          confirmClose ? (
            <span className="delete-confirm" key="close-confirm">
              <span className="delete-confirm-text">{t("detail.closeConfirm")}</span>
              <button
                className="btn btn-danger"
                disabled={actionPending}
                onClick={() => void handleClose()}
              >
                {label("detail.confirmRun", "close")}
              </button>
              <button
                className="btn"
                disabled={actionPending}
                onClick={() => setConfirmClose(false)}
              >
                {t("common.cancel")}
              </button>
            </span>
          ) : (
            <button
              key="close"
              className="btn"
              disabled={actionPending}
              onClick={() => setConfirmClose(true)}
            >
              {t("detail.closeIssue")}
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
            {label("detail.reopen", "reopen")}
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
              {label("detail.readyForReview", "ready:false")}
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
            </span>,
          );
          buttons.push(
            <span className="review-controls" key="review">
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
                title={reviewBody.trim().length === 0 ? t("detail.requestChangesTitle") : undefined}
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
            </span>,
          );
          buttons.push(
            <button
              key="ready-undo"
              className="btn"
              disabled={actionPending}
              onClick={() => handleReadyToggle(true)}
            >
              {label("detail.convertToDraft", "ready:true")}
            </button>,
          );
          buttons.push(
            <button
              key="update-branch"
              className="btn"
              disabled={actionPending}
              onClick={() => handleUpdateBranch()}
            >
              {label("detail.updateBranch", "updateBranch")}
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
            {label("detail.reopen", "reopen")}
          </button>,
        );
      }
    }

    if (buttons.length === 0) return null;
    return <div className="action-bar">{buttons}</div>;
  };

  const actionBar = renderActionBar();

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
        <header className="detail-header">
          <div className="detail-eyebrow">
            <span className="detail-repo">{detail.repo}</span>
            <span className="detail-number">#{detail.number}</span>
            <span className="detail-eyebrow-spacer" />
            {urlActions}
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
              {t("detail.createdUpdated", {
                created: relativeTime(detail.createdAt),
                updated: relativeTime(detail.updatedAt),
              })}
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
                <span className="detail-sticky-actions">{urlActions}</span>
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
            {actionBar}
          </div>
        )}

        <div className="detail-props" ref={propsRef}>
          {detail.kind === "pr" && (
            <div className="prop-row">
              <span className="prop-label">{t("detail.branch")}</span>
              <div className="prop-value pr-info">
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
                {detail.mergeable && (
                  <span
                    className={`mergeable-badge${detail.mergeable === "CONFLICTING" ? " warn" : ""}`}
                  >
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
              </div>
            </div>
          )}

          <div className="prop-row">
            <span className="prop-label">{t("detail.labels")}</span>
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
                              style={{ background: `#${l.color}`, color: labelTextColor(l.color) }}
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
          </div>

          <div className="prop-row">
            <span className="prop-label">{t("detail.assignees")}</span>
            <div className="prop-value assignees-row">
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
          </div>

          <div className="prop-row">
            <span className="prop-label">{t("detail.epics")}</span>
            <div className="prop-value epics-row">
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
              {epics.some((e) => !itemEpicIds.includes(e.id)) && (
                <select
                  className="epic-add-select"
                  value=""
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    if (id) onAddToEpic(id);
                  }}
                >
                  <option value="">{t("detail.addToEpic")}</option>
                  {epics
                    .filter((e) => !itemEpicIds.includes(e.id))
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </select>
              )}
            </div>
          </div>

          {detail.related.length > 0 && (
            <div className="prop-row">
              <span className="prop-label">{t("detail.related")}</span>
              <div className="prop-value related-list">
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
            </div>
          )}

          {detail.kind === "pr" && detail.checks.length > 0 && (
            <div className="prop-row">
              <span className="prop-label">{t("detail.checks")}</span>
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
              <span className="prop-label">{t("detail.reviews")}</span>
              <div className="prop-value prop-value-stack">
                {detail.reviews.map((r, i) => (
                  <div key={`${r.author}-${i}`} className="review-row">
                    <span className="review-author">{r.author ?? "unknown"}</span>
                    <span className={`review-state-badge rs-${r.state.toLowerCase()}`}>
                      {reviewStateLabel(t, r.state)}
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
              {t("common.close")}
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
            <p className="fg-muted">{t("detail.noBody")}</p>
          )}
        </section>

        {detail.kind === "pr" && detail.commits.length > 0 && (
          <section className="commits-section">
            <h3 className="detail-section-title">
              {t("detail.commits")}
              {detail.commitsTotal > 0 && ` (${detail.commitsTotal})`}
            </h3>
            {detail.commitsTotal > detail.commits.length && (
              <p className="comments-hint">
                {t("detail.moreCommits", { n: detail.commitsTotal - detail.commits.length })}
              </p>
            )}
            {detail.commits.map((c) => (
              <div key={c.shortOid} className="commit-row" onClick={() => onOpenUrl(c.url)}>
                {c.authorAvatar ? (
                  <img src={c.authorAvatar} className="avatar avatar-small" alt="" />
                ) : (
                  <span className="avatar avatar-small avatar-placeholder" />
                )}
                <span className="commit-message" title={c.message}>
                  {c.message}
                </span>
                <span className="commit-author">{c.author ?? "unknown"}</span>
                <code className="commit-oid">{c.shortOid}</code>
                <span className="commit-time">{relativeTime(c.date)}</span>
              </div>
            ))}
          </section>
        )}

        <section className="comments-section">
          <h3 className="detail-section-title">
            {t("detail.comments")}
            {detail.commentsTotal > 0 && ` (${detail.commentsTotal})`}
          </h3>
          {detail.commentsTotal > detail.comments.length && (
            <p className="comments-hint">
              {t("detail.moreComments", { n: detail.commentsTotal - detail.comments.length })}
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
            placeholder={t("detail.commentPlaceholder")}
            disabled={actionPending}
          />
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
  );
}

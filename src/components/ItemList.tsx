import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { useEffect, useRef, useState } from "react";
import type { Epic, Item, Stream, Viewer } from "../types";
import { relativeTime } from "./format";
import { COMMENT_ICON, LINK_ICON, Octicon, StateBadge } from "./StateBadge";
import { useI18n } from "../i18n";

/** 無限スクロールの1ページあたりの描画件数 */
const RENDER_PAGE = 50;

type Props = {
  stream: Stream | null;
  items: Item[];
  loading: boolean;
  error: string | null;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  onMarkAllRead: () => void;
  onPollNow: () => void;
  polling: boolean;
  viewer: Viewer | null;
  selectedItemUrl: string | null;
  onItemSelect: (item: Item) => void;
  onItemOpenInBrowser: (item: Item) => void;
  onCopyUrl: (url: string) => Promise<void>;
  onToggleRead: (item: Item) => void;
  onCreateStream: () => void;
  epics: Epic[];
  onToggleEpicMembership: (epicId: number, itemUrl: string, isMember: boolean) => Promise<void>;
};

export function ItemList({
  stream,
  items,
  loading,
  error,
  unreadOnly,
  onToggleUnreadOnly,
  onMarkAllRead,
  onPollNow,
  polling,
  viewer,
  selectedItemUrl,
  onItemSelect,
  onItemOpenInBrowser,
  onCopyUrl,
  onToggleRead,
  onCreateStream,
  epics,
  onToggleEpicMembership,
}: Props) {
  const { t } = useI18n();
  const [renderCount, setRenderCount] = useState(RENDER_PAGE);
  const [queryOpen, setQueryOpen] = useState(
    () => localStorage.getItem("harushion.queryOpen") === "true",
  );

  const sentinelRef = useRef<HTMLDivElement>(null);

  /** 行の右クリックで OS ネイティブメニューを表示する(エピック所属・既読切替・コピー・ブラウザ) */
  const showItemContextMenu = async (item: Item) => {
    // アーカイブ済みエピックは「新規追加」させない。ただし既に所属していれば
    // 外せるよう残す(チェックを外す=削除)
    const menuEpics = epics.filter((e) => !e.archived || item.epicIds.includes(e.id));
    const epicItems =
      menuEpics.length > 0
        ? await Promise.all(
            menuEpics.map((epic) => {
              const isMember = item.epicIds.includes(epic.id);
              return CheckMenuItem.new({
                text: epic.name,
                checked: isMember,
                action: () => void onToggleEpicMembership(epic.id, item.url, isMember),
              });
            }),
          )
        : [await MenuItem.new({ text: t("detail.noEpicsHint"), enabled: false })];
    const menu = await Menu.new({
      items: [
        await Submenu.new({ text: t("list.addToEpic"), items: epicItems }),
        await MenuItem.new({
          text: item.isRead ? t("list.markUnread") : t("list.markRead"),
          action: () => onToggleRead(item),
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          text: t("list.copyUrl"),
          action: () => void onCopyUrl(item.url),
        }),
        await MenuItem.new({
          text: t("detail.openInBrowser"),
          action: () => onItemOpenInBrowser(item),
        }),
      ],
    });
    await menu.popup();
  };

  // Stream やフィルタが変わったら先頭ページに戻す
  useEffect(() => {
    setRenderCount(RENDER_PAGE);
  }, [stream?.id, unreadOnly]);

  // 末尾の番兵が見えたら次のページを描画する
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setRenderCount((c) => c + RENDER_PAGE);
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [items.length, renderCount]);

  return (
    <div className="main">
      <header className="header list-header">
        <h1 className="app-title list-header-title">{stream ? stream.name : "Harushion"}</h1>
        <div className="list-header-top">
          <div className="header-right">
            {stream && (
              <>
                <label className="unread-toggle">
                  <input type="checkbox" checked={unreadOnly} onChange={onToggleUnreadOnly} />
                  {t("list.unreadOnly")}
                </label>
                <button className="btn" onClick={onMarkAllRead}>
                  {t("list.markAllRead")}
                </button>
                <button className="btn btn-primary" onClick={onPollNow} disabled={polling}>
                  {polling ? t("common.updating") : t("common.refresh")}
                </button>
              </>
            )}
            {viewer && (
              <span className="viewer">
                <img src={viewer.avatarUrl} alt="" className="avatar" />
                {viewer.login}
              </span>
            )}
          </div>
        </div>
        {stream && (
          <button
            className="query-toggle"
            onClick={() =>
              setQueryOpen((v) => {
                localStorage.setItem("harushion.queryOpen", String(!v));
                return !v;
              })
            }
          >
            <span className={`folder-arrow${queryOpen ? "" : " collapsed"}`}>▾</span>
            {t("list.queryLabel")}
          </button>
        )}
        {stream && queryOpen && (
          <code className="query list-header-query">
            {stream.query.split("\n").map((line, i) => (
              <span key={i} className="query-line">
                {line}
              </span>
            ))}
          </code>
        )}
      </header>

      <main className="list">
        {error && (
          <div className="error">
            <p>{error}</p>
          </div>
        )}
        {!error && !stream && (
          <div className="empty empty-create">
            <p>{t("list.noStream")}</p>
            <button className="btn btn-primary" onClick={onCreateStream}>
              {t("list.createStream")}
            </button>
          </div>
        )}
        {!error && stream && loading && items.length === 0 && (
          <p className="empty">{t("common.loading")}</p>
        )}
        {!error && stream && !loading && items.length === 0 && (
          <p className="empty">{t("list.emptyItems")}</p>
        )}
        {stream &&
          items.slice(0, renderCount).map((item) => {
            const selected = item.url === selectedItemUrl;
            const assignedToMe = viewer != null && item.assignees.includes(viewer.login);
            const reviewRequestedMe = viewer != null && item.reviewRequests.includes(viewer.login);
            return (
              <div
                key={item.url}
                className={`item ${item.isRead ? "read" : "unread"}${selected ? " selected" : ""}${assignedToMe ? " assigned" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void showItemContextMenu(item);
                }}
              >
                <button
                  className="read-toggle"
                  title={item.isRead ? t("list.markUnread") : t("list.markRead")}
                  onClick={() => onToggleRead(item)}
                >
                  <span className="read-dot" />
                </button>
                <button className="item-open" onClick={() => onItemSelect(item)} title={item.title}>
                  <span className="item-state-col">
                    <StateBadge
                      kind={item.kind}
                      state={item.state}
                      isDraft={item.isDraft}
                      size={16}
                      layout="column"
                    />
                    {(item.comments > 0 || item.relatedCount > 0) && (
                      <span className="item-counts">
                        {item.comments > 0 && (
                          <span className="item-count">
                            <Octicon paths={COMMENT_ICON} size={11} />
                            {item.comments}
                          </span>
                        )}
                        {item.relatedCount > 0 && (
                          <span className="item-count">
                            <Octicon paths={LINK_ICON} size={11} />
                            {item.relatedCount}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="item-main">
                    <span className="item-title">{item.title}</span>
                    <span className="item-meta">
                      {reviewRequestedMe && (
                        <span className="review-req-badge">{t("list.reviewRequestedYou")}</span>
                      )}
                      {assignedToMe && (
                        <span className="assigned-badge">{t("list.assignedYou")}</span>
                      )}
                      {item.repo}#{item.number}
                      {item.author && <> · {item.author}</>}
                      {" · "}
                      {relativeTime(item.updatedAt)}
                    </span>
                    {item.epicIds.length > 0 && (
                      <span className="item-epic-tags">
                        {item.epicIds.map((id) => {
                          const epic = epics.find((e) => e.id === id);
                          if (!epic) return null;
                          const color = epic.color ? `#${epic.color}` : "var(--fg-muted)";
                          return (
                            <span
                              key={id}
                              className="item-epic-tag"
                              style={{
                                color,
                                borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
                              }}
                            >
                              {epic.name}
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        {stream && renderCount < items.length && (
          <div ref={sentinelRef} className="list-sentinel" aria-hidden="true" />
        )}
      </main>
    </div>
  );
}

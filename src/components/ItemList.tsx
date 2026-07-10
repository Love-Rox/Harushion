import { useEffect, useRef, useState } from "react";
import type { Epic, Item, Stream, Viewer } from "../types";
import { relativeTime } from "./format";
import { StateBadge } from "./StateBadge";
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
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [epicPopoverUrl, setEpicPopoverUrl] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!epicPopoverUrl) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setEpicPopoverUrl(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEpicPopoverUrl(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [epicPopoverUrl]);

  const sentinelRef = useRef<HTMLDivElement>(null);

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
      <header className="header">
        <div className="header-title">
          <h1 className="app-title">{stream ? stream.name : "Harushion"}</h1>
          {stream && <code className="query">{stream.query.replace(/\n/g, " | ")}</code>}
        </div>
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
            return (
              <div
                key={item.url}
                className={`item ${item.isRead ? "read" : "unread"}${selected ? " selected" : ""}${assignedToMe ? " assigned" : ""}`}
              >
                <button
                  className="read-toggle"
                  title={item.isRead ? t("list.markUnread") : t("list.markRead")}
                  onClick={() => onToggleRead(item)}
                >
                  <span className="read-dot" />
                </button>
                <button className="item-open" onClick={() => onItemSelect(item)} title={item.title}>
                  <StateBadge
                    kind={item.kind}
                    state={item.state}
                    isDraft={item.isDraft}
                    size={16}
                    layout="column"
                  />
                  <span className="item-main">
                    <span className="item-title">{item.title}</span>
                    <span className="item-meta">
                      {assignedToMe && (
                        <span className="assigned-badge">{t("list.assignedYou")}</span>
                      )}
                      {item.repo}#{item.number}
                      {item.author && <> · {item.author}</>}
                      {" · "}
                      {relativeTime(item.updatedAt)}
                      {item.comments > 0 && <> · 💬{item.comments}</>}
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
                <button
                  className="item-open-browser"
                  title={t("list.addToEpic")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEpicPopoverUrl((prev) => (prev === item.url ? null : item.url));
                  }}
                >
                  ⊕
                </button>
                {epicPopoverUrl === item.url && (
                  <div className="popover item-epic-popover" ref={popoverRef}>
                    {epics.length === 0 && (
                      <p className="popover-empty">{t("detail.noEpicsHint")}</p>
                    )}
                    {epics.map((epic) => {
                      const isMember = item.epicIds.includes(epic.id);
                      return (
                        <button
                          key={epic.id}
                          className="item-epic-popover-row"
                          onClick={() => void onToggleEpicMembership(epic.id, item.url, isMember)}
                        >
                          <span className="item-epic-popover-check">{isMember ? "✓" : ""}</span>
                          {epic.color && (
                            <span
                              className="stream-color-chip"
                              style={{ backgroundColor: `#${epic.color}` }}
                            />
                          )}
                          <span className="item-epic-popover-name">{epic.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  className="item-open-browser"
                  title={t("list.copyUrl")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onCopyUrl(item.url).then(() => {
                      setCopiedUrl(item.url);
                      setTimeout(
                        () => setCopiedUrl((prev) => (prev === item.url ? null : prev)),
                        1500,
                      );
                    });
                  }}
                >
                  {copiedUrl === item.url ? "✓" : "⧉"}
                </button>
                <button
                  className="item-open-browser"
                  title={t("list.openInBrowser", { url: item.url })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onItemOpenInBrowser(item);
                  }}
                >
                  ↗
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

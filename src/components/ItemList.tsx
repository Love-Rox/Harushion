import { useEffect, useRef, useState } from "react";
import type { Item, Stream, Viewer } from "../types";
import { relativeTime } from "./format";
import { StateBadge } from "./StateBadge";

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
  onToggleRead: (item: Item) => void;
  onCreateStream: () => void;
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
  onToggleRead,
  onCreateStream,
}: Props) {
  const [renderCount, setRenderCount] = useState(RENDER_PAGE);
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
                未読のみ
              </label>
              <button className="btn" onClick={onMarkAllRead}>
                全て既読
              </button>
              <button className="btn btn-primary" onClick={onPollNow} disabled={polling}>
                {polling ? "更新中…" : "更新"}
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
            <p>ストリームがありません</p>
            <button className="btn btn-primary" onClick={onCreateStream}>
              + Stream
            </button>
          </div>
        )}
        {!error && stream && loading && items.length === 0 && <p className="empty">読み込み中…</p>}
        {!error && stream && !loading && items.length === 0 && (
          <p className="empty">アイテムがありません</p>
        )}
        {stream &&
          items.slice(0, renderCount).map((item) => {
            const selected = item.url === selectedItemUrl;
            return (
              <div
                key={item.url}
                className={`item ${item.isRead ? "read" : "unread"}${selected ? " selected" : ""}`}
              >
                <button
                  className="read-toggle"
                  title={item.isRead ? "未読にする" : "既読にする"}
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
                      {item.repo}#{item.number}
                      {item.author && <> · {item.author}</>}
                      {" · "}
                      {relativeTime(item.updatedAt)}
                      {item.comments > 0 && <> · 💬{item.comments}</>}
                    </span>
                  </span>
                </button>
                <button
                  className="item-open-browser"
                  title={`${item.url} をブラウザで開く`}
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

import type { Item, Stream, Viewer } from "../types";

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
  onItemClick: (item: Item) => void;
  onToggleRead: (item: Item) => void;
  onCreateStream: () => void;
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  return new Date(iso).toLocaleDateString();
}

function stateLabel(item: Item): { text: string; className: string } {
  if (item.kind === "pr") {
    if (item.state === "MERGED") return { text: "Merged", className: "state-merged" };
    if (item.state === "CLOSED") return { text: "Closed", className: "state-closed" };
    if (item.isDraft) return { text: "Draft", className: "state-draft" };
    return { text: "Open", className: "state-open" };
  }
  if (item.state === "CLOSED") return { text: "Closed", className: "state-closed" };
  return { text: "Open", className: "state-open" };
}

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
  onItemClick,
  onToggleRead,
  onCreateStream,
}: Props) {
  return (
    <div className="main">
      <header className="header">
        <div className="header-title">
          <h1 className="app-title">{stream ? stream.name : "GitViewer"}</h1>
          {stream && <code className="query">{stream.query}</code>}
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
        {!error && stream && !loading && items.length === 0 && <p className="empty">アイテムがありません</p>}
        {stream &&
          items.map((item) => {
            const state = stateLabel(item);
            return (
              <div key={item.url} className={`item ${item.isRead ? "read" : "unread"}`}>
                <button
                  className="read-toggle"
                  title={item.isRead ? "未読にする" : "既読にする"}
                  onClick={() => onToggleRead(item)}
                >
                  <span className="read-dot" />
                </button>
                <button
                  className="item-open"
                  onClick={() => onItemClick(item)}
                  title={`${item.url} をブラウザで開く`}
                >
                  <span className={`kind kind-${item.kind}`}>{item.kind === "pr" ? "PR" : "Issue"}</span>
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
                  <span className={`state ${state.className}`}>{state.text}</span>
                </button>
              </div>
            );
          })}
      </main>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Item, Viewer } from "./types";
import "./App.css";

const DEFAULT_QUERY = "involves:@me sort:updated-desc";

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

function App() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [viewerResult, itemsResult] = await Promise.all([
        invoke<Viewer>("get_viewer"),
        invoke<Item[]>("fetch_items", { query: DEFAULT_QUERY }),
      ]);
      setViewer(viewerResult);
      setItems(itemsResult);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="app">
      <header className="header">
        <h1 className="app-title">GitViewer</h1>
        <code className="query">{DEFAULT_QUERY}</code>
        <div className="header-right">
          <button className="reload" onClick={() => void load()} disabled={loading}>
            {loading ? "更新中…" : "更新"}
          </button>
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
        {!error && loading && items.length === 0 && <p className="empty">読み込み中…</p>}
        {!error && !loading && items.length === 0 && <p className="empty">アイテムがありません</p>}
        {items.map((item) => {
          const state = stateLabel(item);
          return (
            <button
              key={item.url}
              className="item"
              onClick={() => void openUrl(item.url)}
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
          );
        })}
      </main>
    </div>
  );
}

export default App;

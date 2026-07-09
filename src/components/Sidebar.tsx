import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Stream } from "../types";

type Props = {
  streams: Stream[];
  selectedStreamId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onEdit: (stream: Stream) => void;
  graphRepos: string[];
  activeGraphRepo: string | null;
  onSelectGraphRepo: (repo: string) => void;
  onAddGraphRepo: (repo: string) => Promise<void>;
  onRemoveGraphRepo: (repo: string) => void;
};

function sortStreams(streams: Stream[]): Stream[] {
  return [...streams].sort((a, b) => a.position - b.position || a.id - b.id);
}

export function Sidebar({
  streams,
  selectedStreamId,
  onSelect,
  onCreate,
  onEdit,
  graphRepos,
  activeGraphRepo,
  onSelectGraphRepo,
  onAddGraphRepo,
  onRemoveGraphRepo,
}: Props) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [addValue, setAddValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const { root, groups } = useMemo(() => {
    const root: Stream[] = [];
    const byFolder = new Map<string, Stream[]>();
    for (const stream of sortStreams(streams)) {
      if (stream.folder) {
        const list = byFolder.get(stream.folder) ?? [];
        list.push(stream);
        byFolder.set(stream.folder, list);
      } else {
        root.push(stream);
      }
    }
    const groups = [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { root, groups };
  }, [streams]);

  const toggleFolder = (folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  };

  const renderRow = (stream: Stream) => (
    <div
      key={stream.id}
      className={`stream-row${stream.id === selectedStreamId ? " active" : ""}${stream.enabled ? "" : " disabled"}`}
      onClick={() => onSelect(stream.id)}
    >
      <span className="stream-name">{stream.name}</span>
      {stream.unreadCount > 0 && <span className="stream-badge">{stream.unreadCount}</span>}
      <button
        className="stream-edit"
        title="編集"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(stream);
        }}
      >
        ⋯
      </button>
    </div>
  );

  const closeAddForm = () => {
    setAddFormOpen(false);
    setAddValue("");
    setAddError(null);
  };

  const handleAddSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const repo = addValue.trim();
    if (!repo) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAddGraphRepo(repo);
      closeAddForm();
    } catch (err) {
      setAddError(String(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-streams">
        {streams.length === 0 && <p className="sidebar-empty">ストリームがありません</p>}
        {root.map(renderRow)}
        {groups.map(([folder, folderStreams]) => (
          <div className="stream-folder" key={folder}>
            <button className="folder-header" onClick={() => toggleFolder(folder)}>
              <span className={`folder-arrow${collapsedFolders.has(folder) ? " collapsed" : ""}`}>▾</span>
              {folder}
            </button>
            {!collapsedFolders.has(folder) && folderStreams.map(renderRow)}
          </div>
        ))}
      </div>
      <button className="sidebar-add" onClick={onCreate}>
        + Stream
      </button>

      <div className="sidebar-graph-section">
        <div className="sidebar-section-title">ブランチグラフ</div>
        {graphRepos.length === 0 && <p className="sidebar-graph-empty">リポジトリがありません</p>}
        {graphRepos.map((repo) => (
          <div
            key={repo}
            className={`graph-repo-row${repo === activeGraphRepo ? " active" : ""}`}
            onClick={() => onSelectGraphRepo(repo)}
          >
            <span className="graph-repo-name">{repo}</span>
            <button
              className="graph-repo-remove"
              title="削除"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveGraphRepo(repo);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {addFormOpen ? (
          <form className="graph-add-form" onSubmit={(e) => void handleAddSubmit(e)}>
            <input
              type="text"
              className="mono-input"
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              placeholder="owner/name"
              autoFocus
            />
            {addError && <p className="graph-add-error">{addError}</p>}
            <div className="graph-add-actions">
              <button
                type="submit"
                className="btn btn-primary btn-small"
                disabled={adding || addValue.trim().length === 0}
              >
                {adding ? "追加中…" : "追加"}
              </button>
              <button type="button" className="btn btn-small" onClick={closeAddForm} disabled={adding}>
                キャンセル
              </button>
            </div>
          </form>
        ) : (
          <button className="sidebar-add" onClick={() => setAddFormOpen(true)}>
            + リポジトリ
          </button>
        )}
      </div>
    </aside>
  );
}

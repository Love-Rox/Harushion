import { useMemo, useState } from "react";
import type { Stream } from "../types";

type Props = {
  streams: Stream[];
  selectedStreamId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onEdit: (stream: Stream) => void;
};

function sortStreams(streams: Stream[]): Stream[] {
  return [...streams].sort((a, b) => a.position - b.position || a.id - b.id);
}

export function Sidebar({ streams, selectedStreamId, onSelect, onCreate, onEdit }: Props) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

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
    </aside>
  );
}

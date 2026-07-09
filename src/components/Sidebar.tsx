import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, FormEvent } from "react";
import { COLOR_PALETTE } from "../types";
import type { Stream } from "../types";
import "./Sidebar.css";

type Props = {
  streams: Stream[];
  selectedStreamId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onEdit: (stream: Stream) => void;
  folderColors: Record<string, string>;
  onSetFolderColor: (folder: string, color: string | null) => Promise<void>;
  folderOrder: string[];
  onReorderStreams: (ids: number[]) => void;
  onReorderFolders: (folders: string[]) => void;
  graphRepos: string[];
  activeGraphRepo: string | null;
  onSelectGraphRepo: (repo: string) => void;
  onAddGraphRepo: (repo: string) => Promise<void>;
  onRemoveGraphRepo: (repo: string) => void;
};

const STREAM_DND_TYPE = "application/x-gitviewer-stream";
const FOLDER_DND_TYPE = "application/x-gitviewer-folder";

type DropIndicator = { id: number; position: "above" | "below" } | null;
type FolderDropIndicator = { folder: string; position: "above" | "below" } | null;

const NO_TEXT_AUTOFILL = {
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
  autoComplete: "off",
} as const;

function sortStreams(streams: Stream[]): Stream[] {
  return [...streams].sort((a, b) => a.position - b.position || a.id - b.id);
}

export function Sidebar({
  streams,
  selectedStreamId,
  onSelect,
  onCreate,
  onEdit,
  folderColors,
  onSetFolderColor,
  folderOrder,
  onReorderStreams,
  onReorderFolders,
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
  const [colorPopoverFolder, setColorPopoverFolder] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const [draggedStream, setDraggedStream] = useState<{ id: number; folder: string | null } | null>(
    null,
  );
  const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null);
  const [draggedFolder, setDraggedFolder] = useState<string | null>(null);
  const [folderDropIndicator, setFolderDropIndicator] = useState<FolderDropIndicator>(null);

  useEffect(() => {
    if (!colorPopoverFolder) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setColorPopoverFolder(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setColorPopoverFolder(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [colorPopoverFolder]);

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
    const known = folderOrder.filter((folder) => byFolder.has(folder));
    const unknown = [...byFolder.keys()]
      .filter((folder) => !folderOrder.includes(folder))
      .sort((a, b) => a.localeCompare(b));
    const groups: [string, Stream[]][] = [...known, ...unknown].map((folder) => [
      folder,
      byFolder.get(folder)!,
    ]);
    return { root, groups };
  }, [streams, folderOrder]);

  const buildGlobalStreamIds = (
    sectionFolder: string | null,
    newSectionOrder: Stream[],
  ): number[] => {
    const rootIds = (sectionFolder === null ? newSectionOrder : root).map((s) => s.id);
    const folderIds = groups.flatMap(([folder, folderStreams]) =>
      (folder === sectionFolder ? newSectionOrder : folderStreams).map((s) => s.id),
    );
    return [...rootIds, ...folderIds];
  };

  const handleStreamDragStart = (e: DragEvent<HTMLDivElement>, stream: Stream) => {
    e.dataTransfer.setData(STREAM_DND_TYPE, String(stream.id));
    e.dataTransfer.effectAllowed = "move";
    setDraggedStream({ id: stream.id, folder: stream.folder });
  };

  const handleStreamDragEnd = () => {
    setDraggedStream(null);
    setDropIndicator(null);
  };

  const handleStreamDragOver = (
    e: DragEvent<HTMLDivElement>,
    target: Stream,
    sectionFolder: string | null,
  ) => {
    if (!e.dataTransfer.types.includes(STREAM_DND_TYPE)) return;
    if (!draggedStream || draggedStream.folder !== sectionFolder || draggedStream.id === target.id)
      return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const position: "above" | "below" = e.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setDropIndicator({ id: target.id, position });
  };

  const handleStreamDrop = (
    e: DragEvent<HTMLDivElement>,
    target: Stream,
    sectionFolder: string | null,
    sectionStreams: Stream[],
  ) => {
    e.preventDefault();
    const dragged = draggedStream;
    const indicator = dropIndicator;
    setDraggedStream(null);
    setDropIndicator(null);
    if (!dragged || dragged.folder !== sectionFolder || !indicator || indicator.id !== target.id)
      return;
    const draggedObj = sectionStreams.find((s) => s.id === dragged.id);
    if (!draggedObj) return;
    const withoutDragged = sectionStreams.filter((s) => s.id !== dragged.id);
    const targetIndex = withoutDragged.findIndex((s) => s.id === target.id);
    if (targetIndex === -1) return;
    const insertAt = indicator.position === "above" ? targetIndex : targetIndex + 1;
    const newOrder = [
      ...withoutDragged.slice(0, insertAt),
      draggedObj,
      ...withoutDragged.slice(insertAt),
    ];
    onReorderStreams(buildGlobalStreamIds(sectionFolder, newOrder));
  };

  const handleFolderDragStart = (e: DragEvent<HTMLDivElement>, folder: string) => {
    e.dataTransfer.setData(FOLDER_DND_TYPE, folder);
    e.dataTransfer.effectAllowed = "move";
    setDraggedFolder(folder);
  };

  const handleFolderDragEnd = () => {
    setDraggedFolder(null);
    setFolderDropIndicator(null);
  };

  const handleFolderDragOver = (e: DragEvent<HTMLDivElement>, folder: string) => {
    if (!e.dataTransfer.types.includes(FOLDER_DND_TYPE)) return;
    if (!draggedFolder || draggedFolder === folder) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const position: "above" | "below" = e.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setFolderDropIndicator({ folder, position });
  };

  const handleFolderDrop = (e: DragEvent<HTMLDivElement>, folder: string) => {
    e.preventDefault();
    const dragged = draggedFolder;
    const indicator = folderDropIndicator;
    setDraggedFolder(null);
    setFolderDropIndicator(null);
    if (!dragged || dragged === folder || !indicator || indicator.folder !== folder) return;
    const orderedNames = groups.map(([f]) => f);
    const withoutDragged = orderedNames.filter((f) => f !== dragged);
    const targetIndex = withoutDragged.indexOf(folder);
    if (targetIndex === -1) return;
    const insertAt = indicator.position === "above" ? targetIndex : targetIndex + 1;
    const newOrder = [
      ...withoutDragged.slice(0, insertAt),
      dragged,
      ...withoutDragged.slice(insertAt),
    ];
    onReorderFolders(newOrder);
  };

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

  const renderRow = (stream: Stream, sectionFolder: string | null, sectionStreams: Stream[]) => {
    const indicatorClass = dropIndicator?.id === stream.id ? ` drop-${dropIndicator.position}` : "";
    const folderTint = sectionFolder ? folderColors[sectionFolder] : undefined;
    return (
      <div
        key={stream.id}
        className={`stream-row${stream.id === selectedStreamId ? " active" : ""}${stream.enabled ? "" : " disabled"}${draggedStream?.id === stream.id ? " dragging" : ""}${folderTint ? " folder-tinted" : ""}${indicatorClass}`}
        style={folderTint ? ({ "--folder-tint": `#${folderTint}` } as CSSProperties) : undefined}
        draggable
        onDragStart={(e) => handleStreamDragStart(e, stream)}
        onDragEnd={handleStreamDragEnd}
        onDragOver={(e) => handleStreamDragOver(e, stream, sectionFolder)}
        onDrop={(e) => handleStreamDrop(e, stream, sectionFolder, sectionStreams)}
        onClick={() => onSelect(stream.id)}
      >
        {stream.color && (
          <span className="stream-color-chip" style={{ backgroundColor: `#${stream.color}` }} />
        )}
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
  };

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
        {root.map((stream) => renderRow(stream, null, root))}
        {groups.map(([folder, folderStreams]) => {
          const folderColor = folderColors[folder];
          const folderIndicatorClass =
            folderDropIndicator?.folder === folder ? ` drop-${folderDropIndicator.position}` : "";
          return (
            <div className="stream-folder" key={folder}>
              <div
                className={`folder-header-row${draggedFolder === folder ? " dragging" : ""}${folderIndicatorClass}${folderColor ? " folder-tinted" : ""}`}
                style={
                  folderColor
                    ? { backgroundColor: `color-mix(in srgb, #${folderColor} 16%, transparent)` }
                    : undefined
                }
                draggable
                onDragStart={(e) => handleFolderDragStart(e, folder)}
                onDragEnd={handleFolderDragEnd}
                onDragOver={(e) => handleFolderDragOver(e, folder)}
                onDrop={(e) => handleFolderDrop(e, folder)}
              >
                <button className="folder-header" onClick={() => toggleFolder(folder)}>
                  <span
                    className={`folder-arrow${collapsedFolders.has(folder) ? " collapsed" : ""}`}
                  >
                    ▾
                  </span>
                  {folder}
                </button>
                <button
                  className="folder-color-btn"
                  title="フォルダの色"
                  onClick={(e) => {
                    e.stopPropagation();
                    setColorPopoverFolder((prev) => (prev === folder ? null : folder));
                  }}
                >
                  ●
                </button>
                {colorPopoverFolder === folder && (
                  <div className="folder-color-popover" ref={popoverRef}>
                    <div className="color-swatch-row">
                      <button
                        type="button"
                        className={`color-swatch color-swatch-none${!folderColor ? " selected" : ""}`}
                        title="なし"
                        aria-label="色なし"
                        onClick={() => {
                          void onSetFolderColor(folder, null);
                          setColorPopoverFolder(null);
                        }}
                      />
                      {COLOR_PALETTE.map((hex) => (
                        <button
                          type="button"
                          key={hex}
                          className={`color-swatch${folderColor === hex ? " selected" : ""}`}
                          style={{ backgroundColor: `#${hex}` }}
                          aria-label={`色 #${hex}`}
                          onClick={() => {
                            void onSetFolderColor(folder, hex);
                            setColorPopoverFolder(null);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {!collapsedFolders.has(folder) &&
                folderStreams.map((stream) => renderRow(stream, folder, folderStreams))}
            </div>
          );
        })}
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
              {...NO_TEXT_AUTOFILL}
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
              <button
                type="button"
                className="btn btn-small"
                onClick={closeAddForm}
                disabled={adding}
              >
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

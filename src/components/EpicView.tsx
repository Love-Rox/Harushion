import { useState } from "react";
import type { DragEvent } from "react";
import type { Epic, EpicItem, Viewer } from "../types";
import { StateBadge } from "./StateBadge";
import { useI18n } from "../i18n";
import "./EpicView.css";

const EPIC_ITEM_DND_TYPE = "application/x-harushion-epic-item";

type DropIndicator = { url: string; position: "above" | "below" } | null;

type Props = {
  epic: Epic | null;
  items: EpicItem[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  viewer: Viewer | null;
  selectedItemUrl: string | null;
  onItemSelect: (item: EpicItem) => void;
  onRefresh: () => void;
  onEdit: () => void;
  onRemoveItem: (url: string) => void;
  onReorder: (urls: string[]) => void;
};

export function EpicView({
  epic,
  items,
  loading,
  refreshing,
  error,
  viewer,
  selectedItemUrl,
  onItemSelect,
  onRefresh,
  onEdit,
  onRemoveItem,
  onReorder,
}: Props) {
  const { t } = useI18n();
  const [draggedUrl, setDraggedUrl] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, url: string) => {
    e.dataTransfer.setData(EPIC_ITEM_DND_TYPE, url);
    e.dataTransfer.effectAllowed = "move";
    setDraggedUrl(url);
  };

  const handleDragEnd = () => {
    setDraggedUrl(null);
    setDropIndicator(null);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>, targetUrl: string) => {
    if (!e.dataTransfer.types.includes(EPIC_ITEM_DND_TYPE)) return;
    if (!draggedUrl || draggedUrl === targetUrl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const position: "above" | "below" = e.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setDropIndicator({ url: targetUrl, position });
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, targetUrl: string) => {
    e.preventDefault();
    const dragged = draggedUrl;
    const indicator = dropIndicator;
    setDraggedUrl(null);
    setDropIndicator(null);
    if (!dragged || dragged === targetUrl || !indicator || indicator.url !== targetUrl) return;
    const draggedItem = items.find((i) => i.url === dragged);
    if (!draggedItem) return;
    const withoutDragged = items.filter((i) => i.url !== dragged);
    const targetIndex = withoutDragged.findIndex((i) => i.url === targetUrl);
    if (targetIndex === -1) return;
    const insertAt = indicator.position === "above" ? targetIndex : targetIndex + 1;
    const newOrder = [
      ...withoutDragged.slice(0, insertAt),
      draggedItem,
      ...withoutDragged.slice(insertAt),
    ];
    onReorder(newOrder.map((i) => i.url));
  };

  if (!epic) {
    return <div className="main epic-view" />;
  }

  const progressPct = epic.itemCount > 0 ? (epic.doneCount / epic.itemCount) * 100 : 0;

  return (
    <div className="main epic-view">
      <header className="header epic-header">
        <div className="header-title">
          <h1 className="app-title epic-title">
            {epic.color && (
              <span className="epic-title-chip" style={{ backgroundColor: `#${epic.color}` }} />
            )}
            {epic.name}
          </h1>
          <div className="epic-progress">
            <div className="epic-progress-bar">
              <div
                className="epic-progress-fill"
                style={{
                  width: `${progressPct}%`,
                  backgroundColor: epic.color ? `#${epic.color}` : "var(--accent)",
                }}
              />
            </div>
            <span className="epic-progress-text">
              {epic.doneCount}/{epic.itemCount}
            </span>
          </div>
          {epic.note && <p className="epic-note fg-muted">{epic.note}</p>}
        </div>
        <div className="header-right">
          <button className="btn" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? t("common.updating") : t("common.refresh")}
          </button>
          <button className="btn" onClick={onEdit}>
            {t("common.edit")}
          </button>
          {viewer && (
            <span className="viewer">
              <img src={viewer.avatarUrl} alt="" className="avatar" />
              {viewer.login}
            </span>
          )}
        </div>
      </header>

      <main className="list epic-item-list">
        {error && (
          <div className="error">
            <p>{error}</p>
          </div>
        )}
        {!error && loading && items.length === 0 && <p className="empty">{t("common.loading")}</p>}
        {!error && !loading && items.length === 0 && (
          <p className="empty">{t("epic.emptyItems")}</p>
        )}
        {items.map((item, index) => {
          const selected = item.url === selectedItemUrl;
          const indicatorClass =
            dropIndicator?.url === item.url ? ` drop-${dropIndicator.position}` : "";
          return (
            <div
              key={item.url}
              className={`epic-item-row${selected ? " selected" : ""}${draggedUrl === item.url ? " dragging" : ""}${indicatorClass}`}
              draggable
              onDragStart={(e) => handleDragStart(e, item.url)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, item.url)}
              onDrop={(e) => handleDrop(e, item.url)}
            >
              <span className="epic-item-order">{index + 1}</span>
              <button
                className="epic-item-open"
                onClick={() => onItemSelect(item)}
                title={item.title}
              >
                <StateBadge
                  kind={item.kind}
                  state={item.state}
                  isDraft={item.isDraft}
                  size={16}
                  layout="column"
                />
                <span className="epic-item-main">
                  <span className="epic-item-title">{item.title}</span>
                  <span className="epic-item-meta">
                    {item.repo}#{item.number}
                    {item.milestone && (
                      <span className="milestone-chip epic-item-milestone">
                        🎯 {item.milestone}
                      </span>
                    )}
                  </span>
                </span>
              </button>
              <button
                className="epic-item-remove"
                title={t("common.delete")}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveItem(item.url);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </main>
    </div>
  );
}

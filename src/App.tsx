import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  BranchGraph,
  Item,
  ItemAction,
  ItemDetail,
  LabelInfo,
  Stream,
  UpdateInfo,
  Viewer,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { StreamModal } from "./components/StreamModal";
import type {
  StreamCreateInput,
  StreamDuplicateInput,
  StreamUpdateInput,
} from "./components/StreamModal";
import { ItemList } from "./components/ItemList";
import { DetailPane } from "./components/DetailPane";
import { GraphView } from "./components/GraphView";
import "./App.css";

type View = { type: "stream" } | { type: "graph"; repo: string };

function sortStreams(streams: Stream[]): Stream[] {
  return [...streams].sort((a, b) => a.position - b.position || a.id - b.id);
}

function actionKey(action: ItemAction): string {
  if (action.type === "review") return `review:${action.verdict}`;
  if (action.type === "ready") return `ready:${action.undo}`;
  return action.type;
}

function App() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [selectedStreamId, setSelectedStreamId] = useState<number | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingStream, setEditingStream] = useState<Stream | null>(null);
  const [folderColors, setFolderColors] = useState<Record<string, string>>({});
  const [folderOrder, setFolderOrder] = useState<string[]>([]);

  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  const [itemDetail, setItemDetail] = useState<ItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const [repoLabels, setRepoLabels] = useState<Record<string, LabelInfo[]>>({});

  const [view, setView] = useState<View>({ type: "stream" });
  const [graphRepos, setGraphRepos] = useState<string[]>([]);
  const [graphData, setGraphData] = useState<BranchGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);

  const selectedStreamIdRef = useRef<number | null>(null);
  const unreadOnlyRef = useRef(unreadOnly);
  useEffect(() => {
    selectedStreamIdRef.current = selectedStreamId;
  }, [selectedStreamId]);
  useEffect(() => {
    unreadOnlyRef.current = unreadOnly;
  }, [unreadOnly]);

  const loadStreams = useCallback(async (): Promise<Stream[]> => {
    const result = await invoke<Stream[]>("list_streams");
    const sorted = sortStreams(result);
    setStreams(sorted);
    return sorted;
  }, []);

  const loadItems = useCallback(async (streamId: number, unread: boolean) => {
    setItemsLoading(true);
    try {
      const result = await invoke<Item[]>("list_items", { streamId, unreadOnly: unread });
      setItems(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setItemsLoading(false);
    }
  }, []);

  const loadGraphRepos = useCallback(async (): Promise<string[]> => {
    const result = await invoke<string[]>("list_graph_repos");
    setGraphRepos(result);
    return result;
  }, []);

  const loadFolderColors = useCallback(async (): Promise<Record<string, string>> => {
    const result = await invoke<Record<string, string>>("list_folder_colors");
    setFolderColors(result);
    return result;
  }, []);

  const loadFolderOrder = useCallback(async (): Promise<string[]> => {
    const result = await invoke<string[]>("list_folder_order");
    setFolderOrder(result);
    return result;
  }, []);

  const loadGraphData = useCallback(async (repo: string) => {
    setGraphLoading(true);
    setGraphError(null);
    try {
      const result = await invoke<BranchGraph>("get_branch_graph", { repo });
      setGraphData(result);
    } catch (e) {
      setGraphError(String(e));
    } finally {
      setGraphLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [viewerResult, streamsResult] = await Promise.all([
          invoke<Viewer>("get_viewer"),
          loadStreams(),
        ]);
        setViewer(viewerResult);
        if (streamsResult.length > 0) {
          setSelectedStreamId(streamsResult[0].id);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadStreams]);

  useEffect(() => {
    void loadGraphRepos();
  }, [loadGraphRepos]);

  useEffect(() => {
    void loadFolderColors();
  }, [loadFolderColors]);

  useEffect(() => {
    void loadFolderOrder();
  }, [loadFolderOrder]);

  useEffect(() => {
    if (selectedStreamId == null) {
      setItems([]);
      return;
    }
    void loadItems(selectedStreamId, unreadOnly);
  }, [selectedStreamId, unreadOnly, loadItems]);

  useEffect(() => {
    const unlistenPromise = listen<{ streamId: number }>("items-updated", (event) => {
      void loadStreams();
      if (event.payload.streamId === selectedStreamIdRef.current) {
        void loadItems(event.payload.streamId, unreadOnlyRef.current);
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [loadStreams, loadItems]);

  useEffect(() => {
    const unlistenPromise = listen<UpdateInfo>("update-available", (event) => {
      setUpdateInfo(event.payload);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Selected stream changed: clear detail selection.
  useEffect(() => {
    setSelectedItem(null);
    setItemDetail(null);
    setDetailError(null);
  }, [selectedStreamId]);

  // Selected item disappeared from the current list (e.g. filtered out): clear selection.
  useEffect(() => {
    setSelectedItem((prev) => {
      if (prev && !items.some((i) => i.url === prev.url)) {
        setItemDetail(null);
        setDetailError(null);
        return null;
      }
      return prev;
    });
  }, [items]);

  const applyReadState = (url: string, isRead: boolean) => {
    setItems((prev) => prev.map((i) => (i.url === url ? { ...i, isRead } : i)));
  };

  const loadDetail = useCallback(async (url: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result = await invoke<ItemDetail>("get_item_detail", { url });
      setItemDetail(result);
    } catch (e) {
      setDetailError(String(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleSelectItem = async (item: Item) => {
    setSelectedItem(item);
    setItemDetail(null);
    setDetailError(null);
    applyReadState(item.url, true);
    void loadDetail(item.url);
    try {
      await invoke<void>("mark_read", { itemUrl: item.url });
    } catch (e) {
      setError(String(e));
    }
    await loadStreams();
  };

  const handleOpenInBrowser = (item: Item) => {
    void openUrl(item.url);
  };

  const handleOpenUrl = (url: string) => {
    void openUrl(url);
  };

  const handleOpenInApp = (url: string) => {
    invoke<void>("open_in_app_browser", { url }).catch((e) => setDetailError(String(e)));
  };

  const handleCopyUrl = useCallback(async (url: string) => {
    await writeText(url);
  }, []);

  const handleInstallUpdate = async () => {
    setInstallingUpdate(true);
    try {
      await invoke<void>("install_update");
    } catch (e) {
      setError(String(e));
      setInstallingUpdate(false);
    }
  };

  const loadRepoLabels = useCallback(
    async (repo: string): Promise<LabelInfo[]> => {
      const cached = repoLabels[repo];
      if (cached) return cached;
      const result = await invoke<LabelInfo[]>("list_repo_labels", { repo });
      setRepoLabels((prev) => ({ ...prev, [repo]: result }));
      return result;
    },
    [repoLabels],
  );

  const handleAction = async (action: ItemAction): Promise<boolean> => {
    if (!selectedItem) return false;
    setActionPending(true);
    setPendingActionKey(actionKey(action));
    setDetailError(null);
    try {
      await invoke<string>("item_action", {
        url: selectedItem.url,
        kind: selectedItem.kind,
        action,
      });
      await Promise.all([loadDetail(selectedItem.url), loadStreams()]);
      return true;
    } catch (e) {
      setDetailError(String(e));
      return false;
    } finally {
      setActionPending(false);
      setPendingActionKey(null);
    }
  };

  const handleToggleRead = async (item: Item) => {
    const nextRead = !item.isRead;
    applyReadState(item.url, nextRead);
    try {
      await invoke<void>(nextRead ? "mark_read" : "mark_unread", { itemUrl: item.url });
    } catch (e) {
      setError(String(e));
    }
    await loadStreams();
  };

  const handleMarkAllRead = async () => {
    if (selectedStreamId == null) return;
    try {
      await invoke<void>("mark_all_read", { streamId: selectedStreamId });
      await Promise.all([loadStreams(), loadItems(selectedStreamId, unreadOnly)]);
    } catch (e) {
      setError(String(e));
    }
  };

  const handlePollNow = async () => {
    if (selectedStreamId == null) return;
    setPolling(true);
    setError(null);
    try {
      await invoke<number>("poll_stream_now", { streamId: selectedStreamId });
      await Promise.all([loadStreams(), loadItems(selectedStreamId, unreadOnly)]);
    } catch (e) {
      setError(String(e));
    } finally {
      setPolling(false);
    }
  };

  const handleSelectStream = (id: number) => {
    setView({ type: "stream" });
    setSelectedStreamId(id);
  };

  const handleSelectGraphRepo = (repo: string) => {
    setView({ type: "graph", repo });
    setGraphData(null);
    setGraphError(null);
    void loadGraphData(repo);
  };

  const handleAddGraphRepo = async (repo: string) => {
    const updated = await invoke<string[]>("add_graph_repo", { repo });
    setGraphRepos(updated);
    handleSelectGraphRepo(repo);
  };

  const handleRemoveGraphRepo = async (repo: string) => {
    const updated = await invoke<string[]>("remove_graph_repo", { repo });
    setGraphRepos(updated);
    if (view.type === "graph" && view.repo === repo) {
      setView({ type: "stream" });
      setGraphData(null);
      setGraphError(null);
    }
  };

  const handleRefreshGraph = () => {
    if (view.type === "graph") void loadGraphData(view.repo);
  };

  const openCreateModal = () => {
    setEditingStream(null);
    setModalOpen(true);
  };

  const openEditModal = (stream: Stream) => {
    setEditingStream(stream);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingStream(null);
  };

  const handleCreateStream = async (data: StreamCreateInput) => {
    const created = await invoke<Stream>("create_stream", data);
    await loadStreams();
    setSelectedStreamId(created.id);
  };

  const handleUpdateStream = async (data: StreamUpdateInput) => {
    await invoke<Stream>("update_stream", data);
    await loadStreams();
  };

  const handleDeleteStream = async (id: number) => {
    await invoke<void>("delete_stream", { id });
    const remaining = await loadStreams();
    if (selectedStreamId === id) {
      setSelectedStreamId(remaining.length > 0 ? remaining[0].id : null);
    }
  };

  const handleDuplicateStream = async (data: StreamDuplicateInput) => {
    const created = await invoke<Stream>("create_stream", data);
    await loadStreams();
    setSelectedStreamId(created.id);
  };

  const handleSetFolderColor = async (folder: string, color: string | null) => {
    const updated = await invoke<Record<string, string>>("set_folder_color", { folder, color });
    setFolderColors(updated);
  };

  const handleReorderStreams = async (ids: number[]) => {
    setStreams((prev) => {
      const byId = new Map(prev.map((s) => [s.id, s]));
      const reordered = ids
        .map((id, index) => {
          const stream = byId.get(id);
          return stream ? { ...stream, position: index } : null;
        })
        .filter((s): s is Stream => s != null);
      return sortStreams(reordered);
    });
    try {
      const result = await invoke<Stream[]>("reorder_streams", { ids });
      setStreams(sortStreams(result));
    } catch (e) {
      setError(String(e));
      await loadStreams();
    }
  };

  const handleReorderFolders = async (folders: string[]) => {
    setFolderOrder(folders);
    try {
      const result = await invoke<string[]>("reorder_folders", { folders });
      setFolderOrder(result);
    } catch (e) {
      setError(String(e));
      await loadFolderOrder();
    }
  };

  const selectedStream = streams.find((s) => s.id === selectedStreamId) ?? null;

  return (
    <div className="app">
      {updateInfo && (
        <div className="update-banner">
          <span>
            新しいバージョン v{updateInfo.latest} が利用可能です(現在 v{updateInfo.current})。
            {updateInfo.method === "brew" && (
              <>
                <code>brew upgrade --cask harushion</code> で更新できます。
              </>
            )}
          </span>
          {updateInfo.method === "updater" && (
            <button
              className="btn btn-primary btn-small"
              disabled={installingUpdate}
              onClick={() => void handleInstallUpdate()}
            >
              {installingUpdate ? "更新を適用中…" : "今すぐ更新して再起動"}
            </button>
          )}
          <button className="btn btn-small" onClick={() => handleOpenUrl(updateInfo.url)}>
            リリースを開く
          </button>
          <button
            className="update-banner-close"
            aria-label="閉じる"
            onClick={() => setUpdateInfo(null)}
          >
            ×
          </button>
        </div>
      )}
      <div className="app-body">
        <Sidebar
          streams={streams}
          selectedStreamId={selectedStreamId}
          onSelect={handleSelectStream}
          onCreate={openCreateModal}
          onEdit={openEditModal}
          folderColors={folderColors}
          onSetFolderColor={handleSetFolderColor}
          folderOrder={folderOrder}
          onReorderStreams={(ids) => void handleReorderStreams(ids)}
          onReorderFolders={(folders) => void handleReorderFolders(folders)}
          graphRepos={graphRepos}
          activeGraphRepo={view.type === "graph" ? view.repo : null}
          onSelectGraphRepo={handleSelectGraphRepo}
          onAddGraphRepo={handleAddGraphRepo}
          onRemoveGraphRepo={(repo) => void handleRemoveGraphRepo(repo)}
        />
        {view.type === "stream" ? (
          <>
            <ItemList
              stream={selectedStream}
              items={items}
              loading={loading || itemsLoading}
              error={error}
              unreadOnly={unreadOnly}
              onToggleUnreadOnly={() => setUnreadOnly((v) => !v)}
              onMarkAllRead={() => void handleMarkAllRead()}
              onPollNow={() => void handlePollNow()}
              polling={polling}
              viewer={viewer}
              selectedItemUrl={selectedItem?.url ?? null}
              onItemSelect={(item) => void handleSelectItem(item)}
              onItemOpenInBrowser={handleOpenInBrowser}
              onCopyUrl={handleCopyUrl}
              onToggleRead={(item) => void handleToggleRead(item)}
              onCreateStream={openCreateModal}
            />
            <DetailPane
              item={selectedItem}
              detail={itemDetail}
              loading={detailLoading}
              error={detailError}
              actionPending={actionPending}
              pendingActionKey={pendingActionKey}
              viewer={viewer}
              onAction={handleAction}
              onDismissError={() => setDetailError(null)}
              onOpenUrl={handleOpenUrl}
              onOpenInApp={handleOpenInApp}
              onCopyUrl={handleCopyUrl}
              loadRepoLabels={loadRepoLabels}
            />
          </>
        ) : (
          <GraphView
            repo={view.repo}
            data={graphData}
            loading={graphLoading}
            error={graphError}
            onRefresh={handleRefreshGraph}
            onOpenInApp={handleOpenInApp}
          />
        )}
      </div>
      {modalOpen && (
        <StreamModal
          stream={editingStream}
          onClose={closeModal}
          onCreate={handleCreateStream}
          onUpdate={handleUpdateStream}
          onDelete={handleDeleteStream}
          onDuplicate={handleDuplicateStream}
        />
      )}
    </div>
  );
}

export default App;

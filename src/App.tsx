import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BranchGraph, Item, ItemAction, ItemDetail, LabelInfo, Stream, Viewer } from "./types";
import { Sidebar } from "./components/Sidebar";
import { StreamModal } from "./components/StreamModal";
import type { StreamCreateInput, StreamUpdateInput } from "./components/StreamModal";
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
  const [modalOpen, setModalOpen] = useState(false);
  const [editingStream, setEditingStream] = useState<Stream | null>(null);

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

  const selectedStream = streams.find((s) => s.id === selectedStreamId) ?? null;

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar
          streams={streams}
          selectedStreamId={selectedStreamId}
          onSelect={handleSelectStream}
          onCreate={openCreateModal}
          onEdit={openEditModal}
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
        />
      )}
    </div>
  );
}

export default App;

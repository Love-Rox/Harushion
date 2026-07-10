import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  BranchGraph,
  Epic,
  EpicItem,
  EpicSuggestion,
  Item,
  ItemAction,
  ItemDetail,
  LabelInfo,
  RelatedItem,
  Stream,
  UpdateInfo,
  Viewer,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import { StreamModal } from "./components/StreamModal";
import type {
  StreamCreateInput,
  StreamDuplicateInput,
  StreamUpdateInput,
} from "./components/StreamModal";
import { EpicModal } from "./components/EpicModal";
import type { EpicCreateInput, EpicUpdateInput } from "./components/EpicModal";
import { EpicView } from "./components/EpicView";
import { ItemList } from "./components/ItemList";
import { DetailPane } from "./components/DetailPane";
import { GraphView } from "./components/GraphView";
import { useI18n } from "./i18n";
import "./App.css";

type View = { type: "stream" } | { type: "graph"; repo: string } | { type: "epic"; epicId: number };

function sortStreams(streams: Stream[]): Stream[] {
  return [...streams].sort((a, b) => a.position - b.position || a.id - b.id);
}

function sortEpics(epics: Epic[]): Epic[] {
  return [...epics].sort((a, b) => a.position - b.position || a.id - b.id);
}

function actionKey(action: ItemAction): string {
  if (action.type === "review") return `review:${action.verdict}`;
  if (action.type === "ready") return `ready:${action.undo}`;
  return action.type;
}

function App() {
  const { t } = useI18n();
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
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [itemEpicIds, setItemEpicIds] = useState<number[]>([]);

  const [view, setView] = useState<View>({ type: "stream" });
  const [graphRepos, setGraphRepos] = useState<string[]>([]);
  const [graphData, setGraphData] = useState<BranchGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);

  const [epics, setEpics] = useState<Epic[]>([]);
  const [epicItems, setEpicItems] = useState<EpicItem[]>([]);
  const [epicItemsLoading, setEpicItemsLoading] = useState(false);
  const [epicRefreshing, setEpicRefreshing] = useState(false);
  const [epicError, setEpicError] = useState<string | null>(null);
  const [epicModalOpen, setEpicModalOpen] = useState(false);
  const [editingEpic, setEditingEpic] = useState<Epic | null>(null);

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

  const loadEpics = useCallback(async (): Promise<Epic[]> => {
    const result = await invoke<Epic[]>("list_epics");
    const sorted = sortEpics(result);
    setEpics(sorted);
    return sorted;
  }, []);

  const loadEpicItems = useCallback(async (epicId: number) => {
    setEpicItemsLoading(true);
    try {
      const result = await invoke<EpicItem[]>("list_epic_items", { epicId });
      setEpicItems(result);
    } catch (e) {
      setEpicError(String(e));
    } finally {
      setEpicItemsLoading(false);
    }
  }, []);

  const handleToggleEpicArchive = async (epic: Epic) => {
    try {
      await invoke<Epic>("set_epic_archived", { id: epic.id, archived: !epic.archived });
      await loadEpics();
    } catch (e) {
      setEpicError(String(e));
    }
  };

  const toggleEpicMembership = async (epicId: number, itemUrl: string, isMember: boolean) => {
    await invoke<void>(isMember ? "remove_epic_item" : "add_epic_item", { epicId, itemUrl });
    const jobs: Promise<unknown>[] = [loadEpics()];
    if (selectedItem?.url === itemUrl) jobs.push(loadItemEpicIds(itemUrl));
    if (view.type === "epic") jobs.push(loadEpicItems(view.epicId));
    // 行の epicIds チップを最新化
    if (selectedStreamId != null) jobs.push(loadItems(selectedStreamId, unreadOnly));
    await Promise.all(jobs);
  };

  const loadItemEpicIds = useCallback(async (url: string) => {
    try {
      const result = await invoke<number[]>("item_epic_ids", { itemUrl: url });
      setItemEpicIds(result);
    } catch {
      setItemEpicIds([]);
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
    void loadEpics();
  }, [loadEpics]);

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
    setItemEpicIds([]);
  }, [selectedStreamId]);

  // Switched to a different epic's view: clear detail selection.
  const openEpicId = view.type === "epic" ? view.epicId : null;
  useEffect(() => {
    if (openEpicId == null) return;
    setSelectedItem(null);
    setItemDetail(null);
    setDetailError(null);
    setItemEpicIds([]);
  }, [openEpicId]);

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
    setItemEpicIds([]);
    applyReadState(item.url, true);
    void loadDetail(item.url);
    void loadItemEpicIds(item.url);
    try {
      await invoke<void>("mark_read", { itemUrl: item.url });
    } catch (e) {
      setError(String(e));
    }
    await loadStreams();
  };

  // 詳細ペインの関連リンク(Issue⇔PR)クリック。リスト内なら通常の選択フロー、
  // リスト外なら操作対象(selectedItem)ごと差し替えて詳細だけ読み込む(既読処理はしない)
  const handleSelectRelated = (related: RelatedItem) => {
    const listItem = items.find((i) => i.url === related.url);
    if (listItem) {
      void handleSelectItem(listItem);
      return;
    }
    setSelectedItem({
      kind: related.kind,
      number: related.number,
      title: related.title,
      url: related.url,
      state: related.state,
      isDraft: related.isDraft,
      updatedAt: "",
      author: null,
      authorAvatar: null,
      repo: related.repo,
      milestone: null,
      comments: 0,
      assignees: [],
      epicIds: [],
      isRead: true,
    });
    setItemDetail(null);
    setDetailError(null);
    setItemEpicIds([]);
    void loadDetail(related.url);
    void loadItemEpicIds(related.url);
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

  const handleSelectEpic = (epicId: number) => {
    setView({ type: "epic", epicId });
    setEpicItems([]);
    setEpicError(null);
    void loadEpicItems(epicId);
  };

  const openEpicCreateModal = () => {
    setEditingEpic(null);
    setEpicModalOpen(true);
  };

  const openEpicEditModal = (epic: Epic) => {
    setEditingEpic(epic);
    setEpicModalOpen(true);
  };

  const closeEpicModal = () => {
    setEpicModalOpen(false);
    setEditingEpic(null);
  };

  const handleCreateEpic = async (data: EpicCreateInput) => {
    const created = await invoke<Epic>("create_epic", data);
    await loadEpics();
    handleSelectEpic(created.id);
  };

  const handleUpdateEpic = async (data: EpicUpdateInput) => {
    await invoke<Epic>("update_epic", data);
    await loadEpics();
  };

  const handleDeleteEpic = async (id: number) => {
    await invoke<void>("delete_epic", { id });
    await loadEpics();
    if (view.type === "epic" && view.epicId === id) {
      setView({ type: "stream" });
      setEpicItems([]);
      setEpicError(null);
    }
  };

  const loadEpicSuggestions = useCallback(async (): Promise<EpicSuggestion[]> => {
    return invoke<EpicSuggestion[]>("suggest_epics");
  }, []);

  const handleCreateEpicFromMilestone = async (suggestion: EpicSuggestion) => {
    const created = await invoke<Epic>("create_epic_from_milestone", {
      milestone: suggestion.milestone,
      repo: suggestion.repo,
    });
    await loadEpics();
    handleSelectEpic(created.id);
  };

  const handleRefreshEpicItems = async (epicId: number) => {
    setEpicRefreshing(true);
    setEpicError(null);
    try {
      const result = await invoke<EpicItem[]>("refresh_epic_items", { epicId });
      setEpicItems(result);
      await loadEpics();
    } catch (e) {
      setEpicError(String(e));
    } finally {
      setEpicRefreshing(false);
    }
  };

  const handleRemoveEpicItem = async (epicId: number, itemUrl: string) => {
    try {
      await invoke<void>("remove_epic_item", { epicId, itemUrl });
      await Promise.all([loadEpics(), loadEpicItems(epicId)]);
    } catch (e) {
      setEpicError(String(e));
    }
  };

  const handleReorderEpicItems = async (epicId: number, urls: string[]) => {
    setEpicItems((prev) => {
      const byUrl = new Map(prev.map((it) => [it.url, it]));
      return urls
        .map((url, index) => {
          const it = byUrl.get(url);
          return it ? { ...it, epicPosition: index } : null;
        })
        .filter((it): it is EpicItem => it != null);
    });
    try {
      await invoke<void>("reorder_epic_items", { epicId, urls });
    } catch (e) {
      setEpicError(String(e));
      await loadEpicItems(epicId);
    }
  };

  const handleAddItemToEpic = async (epicId: number) => {
    if (!selectedItem) return;
    try {
      await invoke<void>("add_epic_item", { epicId, itemUrl: selectedItem.url });
      await Promise.all([loadEpics(), loadItemEpicIds(selectedItem.url)]);
      if (view.type === "epic" && view.epicId === epicId) void loadEpicItems(epicId);
    } catch (e) {
      setDetailError(String(e));
    }
  };

  const handleRemoveItemFromEpic = async (epicId: number) => {
    if (!selectedItem) return;
    try {
      await invoke<void>("remove_epic_item", { epicId, itemUrl: selectedItem.url });
      await Promise.all([loadEpics(), loadItemEpicIds(selectedItem.url)]);
      if (view.type === "epic" && view.epicId === epicId) void loadEpicItems(epicId);
    } catch (e) {
      setDetailError(String(e));
    }
  };

  const selectedStream = streams.find((s) => s.id === selectedStreamId) ?? null;
  const openEpic = view.type === "epic" ? (epics.find((e) => e.id === view.epicId) ?? null) : null;

  const detailPaneProps = {
    item: selectedItem,
    detail: itemDetail,
    loading: detailLoading,
    error: detailError,
    actionPending,
    pendingActionKey,
    viewer,
    epics,
    itemEpicIds,
    onAddToEpic: (epicId: number) => void handleAddItemToEpic(epicId),
    onRemoveFromEpic: (epicId: number) => void handleRemoveItemFromEpic(epicId),
    onAction: handleAction,
    onDismissError: () => setDetailError(null),
    onOpenUrl: handleOpenUrl,
    onOpenInApp: handleOpenInApp,
    onCopyUrl: handleCopyUrl,
    onSelectRelated: handleSelectRelated,
    loadRepoLabels,
  };

  return (
    <div className="app">
      {updateInfo && (
        <div className="update-banner">
          <span>
            {t("banner.updateAvailable", {
              latest: updateInfo.latest,
              current: updateInfo.current,
            })}
            {updateInfo.method === "brew" && (
              <>
                {t("banner.brewInstructionPrefix")}
                <code>
                  brew upgrade --cask harushion && xattr -rd com.apple.quarantine
                  /Applications/Harushion.app
                </code>
                {t("banner.brewInstructionSuffix")}
              </>
            )}
          </span>
          {updateInfo.method === "updater" && (
            <button
              className="btn btn-primary btn-small"
              disabled={installingUpdate}
              onClick={() => void handleInstallUpdate()}
            >
              {installingUpdate ? t("banner.installing") : t("banner.installAndRestart")}
            </button>
          )}
          <button className="btn btn-small" onClick={() => handleOpenUrl(updateInfo.url)}>
            {t("banner.openRelease")}
          </button>
          <button
            className="update-banner-close"
            aria-label={t("common.close")}
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
          epics={epics}
          activeEpicId={view.type === "epic" ? view.epicId : null}
          onSelectEpic={handleSelectEpic}
          onCreateEpic={openEpicCreateModal}
          onOpenSettings={() => setSettingsOpen(true)}
          onDeleteEpic={handleDeleteEpic}
          graphRepos={graphRepos}
          activeGraphRepo={view.type === "graph" ? view.repo : null}
          onSelectGraphRepo={handleSelectGraphRepo}
          onAddGraphRepo={handleAddGraphRepo}
          onRemoveGraphRepo={(repo) => void handleRemoveGraphRepo(repo)}
        />
        {view.type === "stream" && (
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
              epics={epics}
              onToggleEpicMembership={toggleEpicMembership}
            />
            <DetailPane {...detailPaneProps} />
          </>
        )}
        {view.type === "epic" && (
          <>
            <EpicView
              epic={openEpic}
              items={epicItems}
              loading={epicItemsLoading}
              refreshing={epicRefreshing}
              error={epicError}
              viewer={viewer}
              selectedItemUrl={selectedItem?.url ?? null}
              onItemSelect={(item) => void handleSelectItem(item)}
              onRefresh={() => void handleRefreshEpicItems(view.epicId)}
              onEdit={() => openEpic && openEpicEditModal(openEpic)}
              onToggleArchive={() => void handleToggleEpicArchive(openEpic!)}
              onRemoveItem={(url) => void handleRemoveEpicItem(view.epicId, url)}
              onReorder={(urls) => void handleReorderEpicItems(view.epicId, urls)}
            />
            <DetailPane {...detailPaneProps} />
          </>
        )}
        {view.type === "graph" && (
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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
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
      {epicModalOpen && (
        <EpicModal
          epic={editingEpic}
          onClose={closeEpicModal}
          onCreate={handleCreateEpic}
          onUpdate={handleUpdateEpic}
          onLoadSuggestions={loadEpicSuggestions}
          onCreateFromMilestone={handleCreateEpicFromMilestone}
        />
      )}
    </div>
  );
}

export default App;

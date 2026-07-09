import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Item, Stream, Viewer } from "./types";
import { Sidebar } from "./components/Sidebar";
import { StreamModal } from "./components/StreamModal";
import type { StreamCreateInput, StreamUpdateInput } from "./components/StreamModal";
import { ItemList } from "./components/ItemList";
import "./App.css";

function sortStreams(streams: Stream[]): Stream[] {
  return [...streams].sort((a, b) => a.position - b.position || a.id - b.id);
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

  const applyReadState = (url: string, isRead: boolean) => {
    setItems((prev) => prev.map((i) => (i.url === url ? { ...i, isRead } : i)));
  };

  const handleItemClick = async (item: Item) => {
    void openUrl(item.url);
    applyReadState(item.url, true);
    try {
      await invoke<void>("mark_read", { itemUrl: item.url });
    } catch (e) {
      setError(String(e));
    }
    await loadStreams();
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
          onSelect={setSelectedStreamId}
          onCreate={openCreateModal}
          onEdit={openEditModal}
        />
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
          onItemClick={(item) => void handleItemClick(item)}
          onToggleRead={(item) => void handleToggleRead(item)}
          onCreateStream={openCreateModal}
        />
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

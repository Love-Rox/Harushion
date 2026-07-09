import { useState } from "react";
import type { FormEvent } from "react";
import type { Stream } from "../types";

export type StreamCreateInput = {
  name: string;
  query: string;
  folder: string | null;
  intervalSec: number;
};

export type StreamUpdateInput = StreamCreateInput & { id: number; enabled: boolean };

type Props = {
  stream: Stream | null; // null = create mode, Stream = edit mode
  onClose: () => void;
  onCreate: (data: StreamCreateInput) => Promise<void>;
  onUpdate: (data: StreamUpdateInput) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
};

export function StreamModal({ stream, onClose, onCreate, onUpdate, onDelete }: Props) {
  const [name, setName] = useState(stream?.name ?? "");
  const [query, setQuery] = useState(stream?.query ?? "");
  const [folder, setFolder] = useState(stream?.folder ?? "");
  const [intervalSec, setIntervalSec] = useState(stream?.intervalSec ?? 120);
  const [enabled, setEnabled] = useState(stream?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = name.trim().length > 0;
  const queryValid = query.trim().length > 0;
  const intervalValid = intervalSec >= 60;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!nameValid || !queryValid || !intervalValid) return;
    setSaving(true);
    setError(null);
    try {
      if (stream) {
        await onUpdate({
          id: stream.id,
          name: name.trim(),
          query: query.trim(),
          folder: folder.trim() || null,
          intervalSec,
          enabled,
        });
      } else {
        await onCreate({
          name: name.trim(),
          query: query.trim(),
          folder: folder.trim() || null,
          intervalSec,
        });
      }
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!stream) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete(stream.id);
      onClose();
    } catch (err) {
      setError(String(err));
      setDeleting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{stream ? "ストリームを編集" : "新しいストリーム"}</h2>
        <form onSubmit={handleSubmit}>
          <label className="field">
            <span className="field-label">名前</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 自分宛て"
              autoFocus
            />
          </label>

          <label className="field">
            <span className="field-label">検索クエリ</span>
            <input
              type="text"
              className="mono-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="involves:@me sort:updated-desc"
            />
          </label>

          <label className="field">
            <span className="field-label">フォルダ (任意)</span>
            <input type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="例: 仕事" />
          </label>

          <label className="field">
            <span className="field-label">更新間隔 (秒)</span>
            <input
              type="number"
              min={60}
              value={intervalSec}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
            />
          </label>

          {stream && (
            <label className="field field-row">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span className="field-label">有効</span>
            </label>
          )}

          {error && (
            <div className="error modal-error">
              <p>{error}</p>
            </div>
          )}

          <div className="modal-actions">
            {stream &&
              (confirmingDelete ? (
                <span className="delete-confirm">
                  <span className="delete-confirm-text">本当に削除しますか?</span>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => void handleDelete()}
                    disabled={deleting}
                  >
                    削除する
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                  >
                    キャンセル
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-danger-outline"
                  onClick={() => setConfirmingDelete(true)}
                >
                  削除
                </button>
              ))}
            <span className="modal-actions-spacer" />
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              キャンセル
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || !nameValid || !queryValid || !intervalValid}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

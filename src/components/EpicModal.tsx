import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { COLOR_PALETTE } from "../types";
import type { Epic, EpicSuggestion } from "../types";
import { useI18n } from "../i18n";
import "./EpicModal.css";

export type EpicCreateInput = { name: string; note: string | null; color: string | null };
export type EpicUpdateInput = EpicCreateInput & { id: number };

type Props = {
  epic: Epic | null; // null = create mode, Epic = edit mode
  onClose: () => void;
  onCreate: (data: EpicCreateInput) => Promise<void>;
  onUpdate: (data: EpicUpdateInput) => Promise<void>;
  onLoadSuggestions: () => Promise<EpicSuggestion[]>;
  onCreateFromMilestone: (suggestion: EpicSuggestion) => Promise<void>;
};

const NO_TEXT_AUTOFILL = {
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
  autoComplete: "off",
} as const;

function suggestionKey(s: EpicSuggestion): string {
  return `${s.repo}::${s.milestone}`;
}

export function EpicModal({
  epic,
  onClose,
  onCreate,
  onUpdate,
  onLoadSuggestions,
  onCreateFromMilestone,
}: Props) {
  const { t } = useI18n();
  const [name, setName] = useState(epic?.name ?? "");
  const [note, setNote] = useState(epic?.note ?? "");
  const [color, setColor] = useState<string | null>(epic?.color ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlayMouseDownRef = useRef(false);

  const [suggestions, setSuggestions] = useState<EpicSuggestion[] | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);

  const nameValid = name.trim().length > 0;

  // 提案は作成モードでのみ表示・取得する
  useEffect(() => {
    if (epic) return;
    setSuggestionsLoading(true);
    setSuggestionsError(null);
    onLoadSuggestions()
      .then(setSuggestions)
      .catch((err: unknown) => setSuggestionsError(String(err)))
      .finally(() => setSuggestionsLoading(false));
    // 作成モードでのマウント時に一度だけ実行
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!nameValid) return;
    setSaving(true);
    setError(null);
    try {
      if (epic) {
        await onUpdate({ id: epic.id, name: name.trim(), note: note.trim() || null, color });
      } else {
        await onCreate({ name: name.trim(), note: note.trim() || null, color });
      }
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateFromSuggestion = async (s: EpicSuggestion) => {
    setCreatingKey(suggestionKey(s));
    setSuggestionsError(null);
    try {
      await onCreateFromMilestone(s);
      onClose();
    } catch (err) {
      setSuggestionsError(String(err));
    } finally {
      setCreatingKey(null);
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        overlayMouseDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && overlayMouseDownRef.current) onClose();
      }}
    >
      <div className="modal epic-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{epic ? t("epic.editTitle") : t("epic.createTitle")}</h2>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label className="field">
            <span className="field-label">{t("modal.name")}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("epic.namePlaceholder")}
              autoFocus
              {...NO_TEXT_AUTOFILL}
            />
          </label>

          <label className="field">
            <span className="field-label">{t("epic.note")}</span>
            <textarea
              className="mono-input epic-note-textarea"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("epic.notePlaceholder")}
              {...NO_TEXT_AUTOFILL}
            />
          </label>

          <div className="field">
            <span className="field-label">{t("modal.color")}</span>
            <div className="color-swatch-row">
              <button
                type="button"
                className={`color-swatch color-swatch-none${color === null ? " selected" : ""}`}
                onClick={() => setColor(null)}
                title={t("common.none")}
                aria-label={t("common.noColor")}
              />
              {COLOR_PALETTE.map((hex) => (
                <button
                  type="button"
                  key={hex}
                  className={`color-swatch${color === hex ? " selected" : ""}`}
                  style={{ backgroundColor: `#${hex}` }}
                  onClick={() => setColor(hex)}
                  aria-label={t("common.colorHex", { hex })}
                />
              ))}
            </div>
          </div>

          {error && (
            <div className="error modal-error">
              <p>{error}</p>
            </div>
          )}

          <div className="modal-actions">
            <span className="modal-actions-spacer" />
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || !nameValid}>
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </form>

        {!epic && (
          <div className="epic-suggestions">
            <h3 className="detail-section-title">{t("epic.suggestionsTitle")}</h3>
            {suggestionsLoading && <p className="fg-muted">{t("common.loading")}</p>}
            {suggestionsError && <p className="popover-error">{suggestionsError}</p>}
            {!suggestionsLoading && suggestions && suggestions.length === 0 && (
              <p className="fg-muted">{t("epic.noSuggestions")}</p>
            )}
            {!suggestionsLoading &&
              suggestions?.map((s) => {
                const key = suggestionKey(s);
                return (
                  <div className="epic-suggestion-row" key={key}>
                    <span className="epic-suggestion-text">
                      {t("epic.suggestionLabel", {
                        milestone: s.milestone,
                        repo: s.repo,
                        count: s.count,
                      })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={creatingKey != null}
                      onClick={() => void handleCreateFromSuggestion(s)}
                    >
                      {creatingKey === key ? t("common.saving") : t("epic.createFromSuggestion")}
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

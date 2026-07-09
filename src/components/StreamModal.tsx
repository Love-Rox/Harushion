import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { COLOR_PALETTE } from "../types";
import type { Stream } from "../types";
import "./StreamModal.css";

export type StreamCreateInput = {
  name: string;
  query: string;
  folder: string | null;
  intervalSec: number;
  color: string | null;
};

export type StreamUpdateInput = StreamCreateInput & { id: number; enabled: boolean };
export type StreamDuplicateInput = StreamCreateInput;

type Props = {
  stream: Stream | null; // null = create mode, Stream = edit mode
  onClose: () => void;
  onCreate: (data: StreamCreateInput) => Promise<void>;
  onUpdate: (data: StreamUpdateInput) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onDuplicate: (data: StreamDuplicateInput) => Promise<void>;
};

const NO_TEXT_AUTOFILL = {
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
  autoComplete: "off",
} as const;

// ---- Query builder ----

export type BuilderRelation = "involves" | "author" | "assignee" | "mentions" | "review-requested";

export type BuilderState = {
  kind: "" | "issue" | "pr";
  status: "" | "open" | "closed" | "merged";
  relations: BuilderRelation[];
  repos: string[];
  org: string;
  labels: string[];
  excludeDraft: boolean;
  sort: "" | "updated-desc" | "created-desc" | "comments-desc";
};

const RELATION_OPTIONS: { value: BuilderRelation; label: string }[] = [
  { value: "involves", label: "関与" },
  { value: "author", label: "作成" },
  { value: "assignee", label: "アサイン" },
  { value: "mentions", label: "メンション" },
  { value: "review-requested", label: "レビュー依頼" },
];

const SORT_VALUES = ["updated-desc", "created-desc", "comments-desc"] as const;

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

const GITHUB_SEARCH_DOCS_URL =
  "https://docs.github.com/ja/search-github/searching-on-github/searching-issues-and-pull-requests";

function tokenizeQuery(q: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of q) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Best-effort parse of a raw query string into builder form state. Unrecognized tokens are preserved in `rest`. */
export function parseQuery(q: string): BuilderState & { rest: string } {
  const result: BuilderState & { rest: string } = {
    kind: "",
    status: "",
    relations: [],
    repos: [],
    org: "",
    labels: [],
    excludeDraft: false,
    sort: "",
    rest: "",
  };
  const restTokens: string[] = [];

  for (const token of tokenizeQuery(q.trim())) {
    if (token === "is:issue") {
      result.kind = "issue";
      continue;
    }
    if (token === "is:pr") {
      result.kind = "pr";
      continue;
    }
    if (token === "is:open") {
      result.status = "open";
      continue;
    }
    if (token === "is:closed") {
      result.status = "closed";
      continue;
    }
    if (token === "is:merged") {
      result.status = "merged";
      continue;
    }
    if (token === "-is:draft") {
      result.excludeDraft = true;
      continue;
    }
    const relation = RELATION_OPTIONS.find((r) => token === `${r.value}:@me`);
    if (relation) {
      if (!result.relations.includes(relation.value)) result.relations.push(relation.value);
      continue;
    }
    const repoMatch = /^repo:(.+)$/.exec(token);
    if (repoMatch) {
      result.repos.push(repoMatch[1]);
      continue;
    }
    const orgMatch = /^org:(.+)$/.exec(token);
    if (orgMatch) {
      result.org = orgMatch[1];
      continue;
    }
    const labelQuoted = /^label:"(.*)"$/.exec(token);
    if (labelQuoted) {
      result.labels.push(labelQuoted[1]);
      continue;
    }
    const labelBare = /^label:(.+)$/.exec(token);
    if (labelBare) {
      result.labels.push(labelBare[1]);
      continue;
    }
    const sortMatch = /^sort:(.+)$/.exec(token);
    if (sortMatch && (SORT_VALUES as readonly string[]).includes(sortMatch[1])) {
      result.sort = sortMatch[1] as BuilderState["sort"];
      continue;
    }
    restTokens.push(token);
  }

  result.rest = restTokens.join(" ");
  return result;
}

/** Builds a query string from builder form state. Token order: is:kind, is:status, relations, repos, org, labels, -is:draft, rest, sort. */
export function buildQuery(state: BuilderState & { rest: string }): string {
  const tokens: string[] = [];
  if (state.kind === "issue") tokens.push("is:issue");
  if (state.kind === "pr") tokens.push("is:pr");
  if (state.status === "open") tokens.push("is:open");
  if (state.status === "closed") tokens.push("is:closed");
  if (state.status === "merged") tokens.push("is:merged");
  for (const r of RELATION_OPTIONS) {
    if (state.relations.includes(r.value)) tokens.push(`${r.value}:@me`);
  }
  for (const repo of state.repos) tokens.push(`repo:${repo}`);
  if (state.org.trim()) tokens.push(`org:${state.org.trim()}`);
  for (const label of state.labels) tokens.push(`label:"${label}"`);
  if (state.excludeDraft) tokens.push("-is:draft");
  if (state.rest.trim()) tokens.push(state.rest.trim());
  if (state.sort) tokens.push(`sort:${state.sort}`);
  return tokens.join(" ");
}

/** Splits a saved `query` string into its condition-set lines, trimming each and dropping empty ones. */
export function splitQuerySets(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Joins condition-set lines back into a saved `query` string, trimming each and dropping empty ones. */
export function joinQuerySets(sets: string[]): string {
  return sets
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n");
}

type QueryFormState = BuilderState & { rest: string };

const DEFAULT_FORM_STATE: QueryFormState = {
  kind: "",
  status: "",
  relations: [],
  repos: [],
  org: "",
  labels: [],
  excludeDraft: false,
  sort: "",
  rest: "",
};

export function StreamModal({ stream, onClose, onCreate, onUpdate, onDelete, onDuplicate }: Props) {
  const [name, setName] = useState(stream?.name ?? "");
  const [folder, setFolder] = useState(stream?.folder ?? "");
  const [intervalSec, setIntervalSec] = useState(stream?.intervalSec ?? 120);
  const [enabled, setEnabled] = useState(stream?.enabled ?? true);
  const [color, setColor] = useState<string | null>(stream?.color ?? null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlayMouseDownRef = useRef(false);

  const [mode, setMode] = useState<"builder" | "manual">("builder");
  // 条件セット(query の各行)。 通常操作では常に非空だが、ビルダーで
  // 選択中セットを空にした場合のみ一時的に空文字を保持しうる。
  const [querySets, setQuerySets] = useState<string[]>(() => {
    if (!stream) return [buildQuery({ ...DEFAULT_FORM_STATE, sort: "updated-desc" })];
    const sets = splitQuerySets(stream.query);
    return sets.length > 0 ? sets : [""];
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [builder, setBuilder] = useState<QueryFormState>(() => parseQuery(querySets[0]));
  const [manualText, setManualText] = useState(() => joinQuerySets(querySets));
  const [repoInput, setRepoInput] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState("");

  // 保存対象のクエリ文字列。 手動タブでは manualText、ビルダータブでは
  // querySets を正とし、いずれも空行を除いて trim・結合する。
  const query = mode === "manual" ? joinQuerySets(splitQuerySets(manualText)) : joinQuerySets(querySets);
  const nameValid = name.trim().length > 0;
  const queryValid = query.trim().length > 0;
  const intervalValid = intervalSec >= 60;

  const updateBuilder = (patch: Partial<QueryFormState>) => {
    setBuilder((prev) => {
      const next = { ...prev, ...patch };
      setQuerySets(querySets.map((s, i) => (i === selectedIndex ? buildQuery(next) : s)));
      return next;
    });
  };

  const selectSet = (index: number) => {
    setSelectedIndex(index);
    setBuilder(parseQuery(querySets[index]));
  };

  const addSet = () => {
    const line = buildQuery({ ...DEFAULT_FORM_STATE, sort: "updated-desc" });
    setQuerySets([...querySets, line]);
    setSelectedIndex(querySets.length);
    setBuilder({ ...DEFAULT_FORM_STATE, sort: "updated-desc" });
  };

  const removeSet = (index: number) => {
    if (querySets.length <= 1) return;
    const next = querySets.filter((_, i) => i !== index);
    setQuerySets(next);
    if (index === selectedIndex) {
      const nextIndex = Math.min(selectedIndex, next.length - 1);
      setSelectedIndex(nextIndex);
      setBuilder(parseQuery(next[nextIndex]));
    } else if (index < selectedIndex) {
      setSelectedIndex(selectedIndex - 1);
    }
  };

  const toggleRelation = (relation: BuilderRelation) => {
    const relations = builder.relations.includes(relation)
      ? builder.relations.filter((r) => r !== relation)
      : [...builder.relations, relation];
    updateBuilder({ relations });
  };

  const addRepo = () => {
    const value = repoInput.trim();
    if (!value) return;
    if (!REPO_PATTERN.test(value)) {
      setRepoError("owner/name の形式で入力してください");
      return;
    }
    setRepoError(null);
    setRepoInput("");
    if (builder.repos.includes(value)) return;
    updateBuilder({ repos: [...builder.repos, value] });
  };

  const removeRepo = (value: string) => {
    updateBuilder({ repos: builder.repos.filter((r) => r !== value) });
  };

  const addLabel = () => {
    const value = labelInput.trim();
    if (!value) return;
    setLabelInput("");
    if (builder.labels.includes(value)) return;
    updateBuilder({ labels: [...builder.labels, value] });
  };

  const removeLabel = (value: string) => {
    updateBuilder({ labels: builder.labels.filter((l) => l !== value) });
  };

  const switchToBuilder = () => {
    const sets = splitQuerySets(manualText);
    const nextSets = sets.length > 0 ? sets : [""];
    const nextIndex = Math.min(selectedIndex, nextSets.length - 1);
    setQuerySets(nextSets);
    setSelectedIndex(nextIndex);
    setBuilder(parseQuery(nextSets[nextIndex]));
    setMode("builder");
  };

  const switchToManual = () => {
    setManualText(joinQuerySets(querySets));
    setMode("manual");
  };

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
          color,
        });
      } else {
        await onCreate({
          name: name.trim(),
          query: query.trim(),
          folder: folder.trim() || null,
          intervalSec,
          color,
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

  const handleDuplicate = async () => {
    if (!stream || !nameValid || !queryValid || !intervalValid) return;
    setDuplicating(true);
    setError(null);
    try {
      await onDuplicate({
        name: `${name.trim()} のコピー`,
        query: query.trim(),
        folder: folder.trim() || null,
        intervalSec,
        color,
      });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setDuplicating(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        // モーダル内で始まったドラッグ(テキスト選択等)が外で mouseup しても
        // 閉じないよう、mousedown がオーバーレイ自身で始まった場合のみ閉じる
        overlayMouseDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && overlayMouseDownRef.current) onClose();
      }}
    >
      <div className="modal stream-modal" onClick={(e) => e.stopPropagation()}>
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
              {...NO_TEXT_AUTOFILL}
            />
          </label>

          <div className="field">
            <div className="query-field-header">
              <span className="field-label">検索クエリ</span>
              <div className="query-mode-tabs">
                <button
                  type="button"
                  className={mode === "builder" ? "query-mode-tab active" : "query-mode-tab"}
                  onClick={switchToBuilder}
                >
                  ビルダー
                </button>
                <button
                  type="button"
                  className={mode === "manual" ? "query-mode-tab active" : "query-mode-tab"}
                  onClick={switchToManual}
                >
                  手動
                </button>
              </div>
            </div>

            <div className="query-set-chip-row">
              {querySets.map((_, i) => (
                <span key={i} className={`query-set-chip${i === selectedIndex ? " active" : ""}`}>
                  <button type="button" className="query-set-chip-select" onClick={() => selectSet(i)}>
                    条件{i + 1}
                  </button>
                  {querySets.length > 1 && (
                    <button
                      type="button"
                      className="chip-remove"
                      onClick={() => removeSet(i)}
                      aria-label={`条件${i + 1} を削除`}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              <button type="button" className="btn btn-small query-set-add" onClick={addSet}>
                + 条件を追加
              </button>
            </div>

            {mode === "builder" ? (
              <div className="query-builder">
                <div className="query-builder-row">
                  <label className="field">
                    <span className="field-label">種別</span>
                    <select
                      value={builder.kind}
                      onChange={(e) =>
                        updateBuilder({ kind: e.target.value as BuilderState["kind"] })
                      }
                    >
                      <option value="">すべて</option>
                      <option value="issue">Issue</option>
                      <option value="pr">Pull Request</option>
                    </select>
                  </label>

                  <label className="field">
                    <span className="field-label">状態</span>
                    <select
                      value={builder.status}
                      onChange={(e) =>
                        updateBuilder({ status: e.target.value as BuilderState["status"] })
                      }
                    >
                      <option value="">すべて</option>
                      <option value="open">Open</option>
                      <option value="closed">Closed</option>
                      <option value="merged">マージ済み</option>
                    </select>
                  </label>
                </div>

                <div className="field">
                  <span className="field-label">自分との関係</span>
                  <div className="builder-checkboxes">
                    {RELATION_OPTIONS.map((opt) => (
                      <label key={opt.value} className="builder-checkbox">
                        <input
                          type="checkbox"
                          checked={builder.relations.includes(opt.value)}
                          onChange={() => toggleRelation(opt.value)}
                        />
                        <span>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <span className="field-label">リポジトリ</span>
                  <div className="chip-input-row">
                    <input
                      type="text"
                      value={repoInput}
                      onChange={(e) => {
                        setRepoInput(e.target.value);
                        setRepoError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addRepo();
                        }
                      }}
                      placeholder="owner/name"
                      {...NO_TEXT_AUTOFILL}
                    />
                    <button type="button" className="btn btn-small" onClick={addRepo}>
                      追加
                    </button>
                  </div>
                  {repoError && <p className="field-error">{repoError}</p>}
                  {builder.repos.length > 0 && (
                    <div className="chip-list">
                      {builder.repos.map((r) => (
                        <span key={r} className="chip">
                          {r}
                          <button
                            type="button"
                            className="chip-remove"
                            onClick={() => removeRepo(r)}
                            aria-label={`${r} を削除`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <label className="field">
                  <span className="field-label">Org</span>
                  <input
                    type="text"
                    value={builder.org}
                    onChange={(e) => updateBuilder({ org: e.target.value })}
                    placeholder="例: octocat-inc"
                    {...NO_TEXT_AUTOFILL}
                  />
                </label>

                <div className="field">
                  <span className="field-label">ラベル</span>
                  <div className="chip-input-row">
                    <input
                      type="text"
                      value={labelInput}
                      onChange={(e) => setLabelInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addLabel();
                        }
                      }}
                      placeholder="例: bug"
                      {...NO_TEXT_AUTOFILL}
                    />
                    <button type="button" className="btn btn-small" onClick={addLabel}>
                      追加
                    </button>
                  </div>
                  {builder.labels.length > 0 && (
                    <div className="chip-list">
                      {builder.labels.map((l) => (
                        <span key={l} className="chip">
                          {l}
                          <button
                            type="button"
                            className="chip-remove"
                            onClick={() => removeLabel(l)}
                            aria-label={`${l} を削除`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <label className="field field-row">
                  <input
                    type="checkbox"
                    checked={builder.excludeDraft}
                    onChange={(e) => updateBuilder({ excludeDraft: e.target.checked })}
                  />
                  <span className="field-label">Draft を除外</span>
                </label>

                <label className="field">
                  <span className="field-label">並び順</span>
                  <select
                    value={builder.sort}
                    onChange={(e) =>
                      updateBuilder({ sort: e.target.value as BuilderState["sort"] })
                    }
                  >
                    <option value="updated-desc">更新が新しい順</option>
                    <option value="created-desc">作成が新しい順</option>
                    <option value="comments-desc">コメントが多い順</option>
                    <option value="">指定なし</option>
                  </select>
                </label>

                <label className="field">
                  <span className="field-label">その他の条件</span>
                  <input
                    type="text"
                    className="mono-input"
                    value={builder.rest}
                    onChange={(e) => updateBuilder({ rest: e.target.value })}
                    placeholder="例: no:assignee"
                    {...NO_TEXT_AUTOFILL}
                  />
                </label>

                <div className="query-preview mono-input">{buildQuery(builder) || "(クエリなし)"}</div>
                {querySets.length > 1 && (
                  <div className="query-merge-count">マージ結果: {querySets.length} 件の条件セット</div>
                )}
              </div>
            ) : (
              <textarea
                className="mono-input query-manual-textarea"
                rows={3}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder={"involves:@me sort:updated-desc\nrepo:org/name is:pr"}
                {...NO_TEXT_AUTOFILL}
              />
            )}

            <a
              className="query-docs-link"
              href={GITHUB_SEARCH_DOCS_URL}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(GITHUB_SEARCH_DOCS_URL);
              }}
            >
              クエリ構文について
            </a>
          </div>

          <label className="field">
            <span className="field-label">フォルダ (任意)</span>
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="例: 仕事"
              {...NO_TEXT_AUTOFILL}
            />
          </label>

          <div className="field">
            <span className="field-label">色</span>
            <div className="color-swatch-row">
              <button
                type="button"
                className={`color-swatch color-swatch-none${color === null ? " selected" : ""}`}
                onClick={() => setColor(null)}
                title="なし"
                aria-label="色なし"
              />
              {COLOR_PALETTE.map((hex) => (
                <button
                  type="button"
                  key={hex}
                  className={`color-swatch${color === hex ? " selected" : ""}`}
                  style={{ backgroundColor: `#${hex}` }}
                  onClick={() => setColor(hex)}
                  aria-label={`色 #${hex}`}
                />
              ))}
            </div>
          </div>

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
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span className="field-label">有効</span>
            </label>
          )}

          {error && (
            <div className="error modal-error">
              <p>{error}</p>
            </div>
          )}

          <div className="modal-actions">
            {stream && (
              <button
                type="button"
                className="btn duplicate-btn"
                onClick={() => void handleDuplicate()}
                disabled={
                  saving || deleting || duplicating || !nameValid || !queryValid || !intervalValid
                }
              >
                {duplicating ? "複製中…" : "複製"}
              </button>
            )}
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

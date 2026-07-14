// アプリアイコン(Dock/タスクバー)の未読バッジ設定。テーマ同様 localStorage に保持する
export type BadgeMode = "count" | "dot" | "none";

const STORAGE_KEY = "harushion.badgeMode";

export function getBadgeMode(): BadgeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "dot" || v === "none" ? v : "count";
}

export function setBadgeMode(mode: BadgeMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
}

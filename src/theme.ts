// テーマ設定: "system" は OS 設定に追従。解決結果を <html data-theme="light|dark"> に
// 常時反映することで、CSS はダークトークンを :root[data-theme="dark"] の一箇所だけで持てる。
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "harushion.theme";
const listeners = new Set<() => void>();

let preference: ThemePreference = (() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
})();

const media = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedTheme(): "light" | "dark" {
  if (preference === "system") return media.matches ? "dark" : "light";
  return preference;
}

function apply() {
  document.documentElement.dataset.theme = resolvedTheme();
}

media.addEventListener("change", () => {
  if (preference === "system") apply();
});

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  localStorage.setItem(STORAGE_KEY, next);
  apply();
  for (const listener of listeners) listener();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** アプリ起動時に一度呼び、初期テーマを適用する */
export function initTheme() {
  apply();
}

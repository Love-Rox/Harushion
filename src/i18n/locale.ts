export type Locale = "ja" | "en";

const STORAGE_KEY = "harushion.locale";

function detectLocale(): Locale {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "ja" || stored === "en") return stored;
  }
  if (typeof navigator !== "undefined" && navigator.language?.startsWith("ja")) return "ja";
  return "en";
}

type Listener = (locale: Locale) => void;

let currentLocale: Locale = detectLocale();
const listeners = new Set<Listener>();

/** Current locale, readable from non-React modules (e.g. format.ts). */
export function getLocale(): Locale {
  return currentLocale;
}

/** Sets the locale, persists it, and notifies subscribers (the I18nProvider). */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, locale);
  }
  for (const listener of listeners) listener(locale);
}

export function subscribeLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

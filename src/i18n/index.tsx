import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ja } from "./ja";
import type { Messages } from "./ja";
import { en } from "./en";
import { getLocale, setLocale as setLocaleGlobal, subscribeLocale } from "./locale";
import type { Locale } from "./locale";

export type { Locale } from "./locale";

const DICTIONARIES: Record<Locale, Messages> = { ja, en };

type Primitive = string | number | boolean;

/** Dot-path union of every string leaf in Messages, e.g. "modal.repoInvalid". */
type PathsOf<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends Primitive
    ? `${Prefix}${K}`
    : T[K] extends Record<string, unknown>
      ? PathsOf<T[K], `${Prefix}${K}.`>
      : never;
}[keyof T & string];

export type MessagePath = PathsOf<Messages>;

function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current != null && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

export type TFunction = (path: MessagePath, vars?: Record<string, string | number>) => string;

type I18nContextValue = {
  t: TFunction;
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getLocale);

  useEffect(() => subscribeLocale(setLocaleState), []);

  const value = useMemo<I18nContextValue>(() => {
    const dict = DICTIONARIES[locale];
    const t: TFunction = (path, vars) => {
      const raw = getByPath(dict, path);
      return typeof raw === "string" ? interpolate(raw, vars) : path;
    };
    return { t, locale, setLocale: setLocaleGlobal };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
}

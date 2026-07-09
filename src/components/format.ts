import { getLocale } from "../i18n/locale";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";

const TIME_DICTIONARIES = { ja: ja.time, en: en.time };

function interpolate(template: string, n: number): string {
  return template.replace("{n}", String(n));
}

export function relativeTime(iso: string): string {
  const locale = getLocale();
  const t = TIME_DICTIONARIES[locale];
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t.justNow;
  if (minutes < 60) return interpolate(t.minutesAgo, minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return interpolate(t.hoursAgo, hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return interpolate(t.daysAgo, days);
  return new Date(iso).toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US");
}

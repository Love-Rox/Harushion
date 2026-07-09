import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relativeTime } from "./format";
import { setLocale } from "../i18n/locale";

describe("relativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    setLocale("en");
  });

  describe("ja", () => {
    beforeEach(() => setLocale("ja"));

    it.each([
      ["2026-07-09T11:59:40Z", "たった今"],
      ["2026-07-09T11:55:00Z", "5分前"],
      ["2026-07-09T09:00:00Z", "3時間前"],
      ["2026-06-29T12:00:00Z", "10日前"],
    ])("%s → %s", (iso, expected) => {
      expect(relativeTime(iso)).toBe(expected);
    });

    it("falls back to a locale date for 30+ days", () => {
      const iso = "2026-05-01T00:00:00Z";
      expect(relativeTime(iso)).toBe(new Date(iso).toLocaleDateString("ja-JP"));
    });
  });

  describe("en", () => {
    beforeEach(() => setLocale("en"));

    it.each([
      ["2026-07-09T11:59:40Z", "just now"],
      ["2026-07-09T11:55:00Z", "5m ago"],
      ["2026-07-09T09:00:00Z", "3h ago"],
      ["2026-06-29T12:00:00Z", "10d ago"],
    ])("%s → %s", (iso, expected) => {
      expect(relativeTime(iso)).toBe(expected);
    });

    it("falls back to a locale date for 30+ days", () => {
      const iso = "2026-05-01T00:00:00Z";
      expect(relativeTime(iso)).toBe(new Date(iso).toLocaleDateString("en-US"));
    });
  });
});

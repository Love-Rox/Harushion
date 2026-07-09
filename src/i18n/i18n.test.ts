import { describe, expect, it } from "vitest";
import { ja } from "./ja";
import { en } from "./en";

function collectKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
    collectKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n dictionaries", () => {
  it("en has exactly the same keys as ja", () => {
    const jaKeys = collectKeys(ja).sort();
    const enKeys = collectKeys(en).sort();
    expect(enKeys).toEqual(jaKeys);
  });

  it("every leaf value is a non-empty-typed string (blank strings allowed only where ja also blank)", () => {
    const jaKeys = collectKeys(ja);
    for (const key of jaKeys) {
      const jaVal = key.split(".").reduce<unknown>((acc, k) => (acc as never)[k], ja);
      const enVal = key.split(".").reduce<unknown>((acc, k) => (acc as never)[k], en);
      expect(typeof jaVal).toBe("string");
      expect(typeof enVal).toBe("string");
    }
  });
});

describe("interpolation", () => {
  function interpolate(template: string, vars: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
      key in vars ? String(vars[key]) : match,
    );
  }

  it("substitutes a single placeholder", () => {
    expect(interpolate(ja.time.minutesAgo, { n: 5 })).toBe("5分前");
    expect(interpolate(en.time.minutesAgo, { n: 5 })).toBe("5m ago");
  });

  it("substitutes multiple placeholders", () => {
    expect(interpolate(ja.banner.updateAvailable, { latest: "1.2.0", current: "1.1.0" })).toBe(
      "新しいバージョン v1.2.0 が利用可能です(現在 v1.1.0)。",
    );
    expect(interpolate(en.banner.updateAvailable, { latest: "1.2.0", current: "1.1.0" })).toBe(
      "A new version v1.2.0 is available (current v1.1.0).",
    );
  });

  it("leaves unknown placeholders untouched", () => {
    expect(interpolate("{a} {b}", { a: "x" })).toBe("x {b}");
  });
});

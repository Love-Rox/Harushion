import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { Locale } from "../i18n";
import { getThemePreference, setThemePreference } from "../theme";
import type { ThemePreference } from "../theme";
import type { BadgeMode } from "../badge";

type Props = {
  badgeMode: BadgeMode;
  onBadgeModeChange: (mode: BadgeMode) => void;
  onClose: () => void;
};

export function SettingsModal({ badgeMode, onBadgeModeChange, onClose }: Props) {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());
  const overlayMouseDownRef = useRef(false);

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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{t("settings.title")}</h2>

        <label className="field">
          <span className="field-label">{t("sidebar.localeLabel")}</span>
          <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">{t("sidebar.themeLabel")}</span>
          <select
            value={theme}
            onChange={(e) => {
              const next = e.target.value as ThemePreference;
              setThemePreference(next);
              setTheme(next);
            }}
          >
            <option value="system">{t("sidebar.themeSystem")}</option>
            <option value="light">{t("sidebar.themeLight")}</option>
            <option value="dark">{t("sidebar.themeDark")}</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">{t("settings.badgeLabel")}</span>
          <select
            value={badgeMode}
            onChange={(e) => onBadgeModeChange(e.target.value as BadgeMode)}
          >
            <option value="count">{t("settings.badgeCount")}</option>
            <option value="dot">{t("settings.badgeDot")}</option>
            <option value="none">{t("settings.badgeNone")}</option>
          </select>
        </label>

        <div className="modal-actions settings-modal-actions">
          <button className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

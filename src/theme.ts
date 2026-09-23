import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLayoutEffect, useState } from "react";
import {
  readThemePreferences,
  resolveTheme,
  type Appearance,
  type ThemePreferences,
} from "./themePreferences";

const THEME_STORAGE_KEY = "codex-auth-switch-theme";
const LEGACY_THEME_STORAGE_KEY = "codex-account-switch-theme";

const systemTheme = (): Appearance =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

const storedTheme = (): ThemePreferences =>
  readThemePreferences(
    window.localStorage.getItem(THEME_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY),
  );

const applyTheme = (theme: ThemePreferences, systemAppearance: Appearance) => {
  const { appearance, palette } = resolveTheme(theme, systemAppearance);
  document.documentElement.dataset.theme = appearance;
  document.documentElement.dataset.palette = palette;
  document.documentElement.style.colorScheme = appearance;
};

const initialTheme = storedTheme();
applyTheme(initialTheme, systemTheme());

export const useAppearance = () => {
  const [theme, setTheme] = useState<ThemePreferences>(initialTheme);

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => applyTheme(theme, media.matches ? "dark" : "light");

    syncTheme();
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
    window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);

    if (theme.mode !== "system") return;
    media.addEventListener("change", syncTheme);
    return () => media.removeEventListener("change", syncTheme);
  }, [theme]);

  useLayoutEffect(() => {
    if ("__TAURI_INTERNALS__" in window) {
      void getCurrentWindow()
        .setTheme(theme.mode === "system" ? null : theme.mode)
        .catch(() => undefined);
    }
  }, [theme.mode]);

  return { setTheme, theme };
};

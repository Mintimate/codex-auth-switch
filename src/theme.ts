import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLayoutEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = Exclude<ThemeMode, "system">;

const THEME_STORAGE_KEY = "codex-auth-switch-theme";
const LEGACY_THEME_STORAGE_KEY = "codex-account-switch-theme";

const systemTheme = (): ResolvedTheme =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

const storedTheme = (): ThemeMode => {
  const value =
    window.localStorage.getItem(THEME_STORAGE_KEY) ??
    window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
};

const applyTheme = (theme: ResolvedTheme) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
};

const initialTheme = storedTheme();
applyTheme(initialTheme === "system" ? systemTheme() : initialTheme);

export const useAppearance = () => {
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () =>
      applyTheme(
        theme === "system" ? (media.matches ? "dark" : "light") : theme,
      );

    syncTheme();
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);

    if ("__TAURI_INTERNALS__" in window) {
      void getCurrentWindow()
        .setTheme(theme === "system" ? null : theme)
        .catch(() => undefined);
    }

    if (theme !== "system") return;
    media.addEventListener("change", syncTheme);
    return () => media.removeEventListener("change", syncTheme);
  }, [theme]);

  return { setTheme, theme };
};

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useState } from "react";

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
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    theme === "system" ? systemTheme() : theme,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (theme === "system") {
        setResolvedTheme(media.matches ? "dark" : "light");
      }
    };

    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  useLayoutEffect(() => {
    const nextResolved = theme === "system" ? systemTheme() : theme;
    setResolvedTheme(nextResolved);
    applyTheme(nextResolved);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);

    if ("__TAURI_INTERNALS__" in window) {
      void getCurrentWindow()
        .setTheme(theme === "system" ? null : theme)
        .catch(() => undefined);
    }
  }, [theme]);

  useLayoutEffect(() => applyTheme(resolvedTheme), [resolvedTheme]);

  return { resolvedTheme, setTheme, theme };
};

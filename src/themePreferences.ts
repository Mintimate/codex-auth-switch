export const LIGHT_THEMES = [
  { value: "default_light", name: "themeDefaultLight" },
  { value: "mint_light_blue", name: "themeMintLightBlue" },
  { value: "mint_light_green", name: "themeMintLightGreen" },
] as const;

export const DARK_THEMES = [
  { value: "default_dark", name: "themeDefaultDark" },
  { value: "mint_dark_blue", name: "themeMintDarkBlue" },
  { value: "mint_dark_green", name: "themeMintDarkGreen" },
] as const;

export type Appearance = "light" | "dark";
export type ThemeMode = Appearance | "system";
export type ThemePreferences = {
  mode: ThemeMode;
  light: (typeof LIGHT_THEMES)[number]["value"];
  dark: (typeof DARK_THEMES)[number]["value"];
};

const defaults: ThemePreferences = {
  mode: "system",
  light: "default_light",
  dark: "default_dark",
};

export const readThemePreferences = (
  stored: string | null,
): ThemePreferences => {
  // 迁移已发布版本保存的外观模式。
  if (stored === "light" || stored === "dark" || stored === "system") {
    return { ...defaults, mode: stored };
  }
  let value: unknown;
  try {
    value = JSON.parse(stored ?? "null");
  } catch {
    return { ...defaults };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...defaults };
  }
  const preferences = value as Record<string, unknown>;
  return {
    mode:
      preferences.mode === "light" || preferences.mode === "dark"
        ? preferences.mode
        : "system",
    light:
      LIGHT_THEMES.find((theme) => theme.value === preferences.light)?.value ??
      defaults.light,
    dark:
      DARK_THEMES.find((theme) => theme.value === preferences.dark)?.value ??
      defaults.dark,
  };
};

export const resolveTheme = (
  preferences: ThemePreferences,
  systemAppearance: Appearance,
) => {
  const appearance =
    preferences.mode === "system" ? systemAppearance : preferences.mode;
  return { appearance, palette: preferences[appearance] };
};

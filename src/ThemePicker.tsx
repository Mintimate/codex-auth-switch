import { Monitor, Moon, Sun } from "lucide-react";
import { useId } from "react";
import type { Translate } from "./i18n";
import {
  DARK_THEMES,
  LIGHT_THEMES,
  type ThemePreferences,
} from "./themePreferences";
import "./ThemePicker.css";

const modes = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;

const paletteGroups = [
  {
    appearance: "light",
    title: "themeLightPalette",
    palettes: LIGHT_THEMES,
    icon: Sun,
  },
  {
    appearance: "dark",
    title: "themeDarkPalette",
    palettes: DARK_THEMES,
    icon: Moon,
  },
] as const;

export function ThemePicker({
  value,
  onChange,
  t,
}: {
  value: ThemePreferences;
  onChange: (theme: ThemePreferences) => void;
  t: Translate;
}) {
  const id = useId();

  return (
    <section
      className="settings-group theme-section"
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`}>{t("appearance")}</h3>
      <p className="theme-picker-hint" id={`${id}-hint`}>
        {t("appearanceHint")}
      </p>
      <fieldset
        className="theme-picker theme-mode-picker"
        aria-describedby={`${id}-hint`}
      >
        <legend>{t("themeMode")}</legend>
        <div className="theme-modes">
          {modes.map(({ value: mode, icon: Icon }) => (
            <label className="theme-mode" key={mode}>
              <input
                type="radio"
                name={`${id}-mode`}
                value={mode}
                checked={value.mode === mode}
                onChange={() => onChange({ ...value, mode })}
              />
              <Icon size={15} aria-hidden="true" />
              <span>{t(mode)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="theme-palette-groups">
        {paletteGroups.map(({ appearance, title, palettes, icon: Icon }) => (
          <fieldset className="theme-picker" key={appearance}>
            <legend>
              <span className="theme-palette-heading">
                <Icon size={15} aria-hidden="true" />
                {t(title)}
              </span>
            </legend>
            <div className="theme-preset-grid">
              {palettes.map(({ value: theme, name }) => (
                <label className="theme-preset" key={theme}>
                  <span
                    className="theme-preview"
                    data-palette={theme}
                    aria-hidden="true"
                  >
                    <span className="theme-preview-sidebar">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="theme-preview-content">
                      <span className="theme-preview-title" />
                      <span className="theme-preview-card">
                        <i />
                        <i />
                        <span />
                      </span>
                    </span>
                  </span>
                  <span className="theme-preset-caption">
                    <span>
                      <strong>{t(name)}</strong>
                      <small>
                        {t(
                          theme.startsWith("default_")
                            ? "themeDefault"
                            : appearance,
                        )}
                      </small>
                    </span>
                    <input
                      type="radio"
                      name={`${id}-${appearance}`}
                      value={theme}
                      checked={value[appearance] === theme}
                      aria-label={t(name)}
                      onChange={() =>
                        onChange({ ...value, [appearance]: theme })
                      }
                    />
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <p className="theme-name-hint">{t("themeNameHint")}</p>
    </section>
  );
}

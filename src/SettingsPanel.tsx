import { AppStatus } from "./api";
import { Locale, Translate } from "./i18n";
import { ThemeMode } from "./theme";

export type AppTab = "accounts" | "usage" | "settings";

type Option<T extends string> = {
  label: string;
  value: T;
};

type SettingsPanelProps = {
  autoRefreshUsage: boolean;
  defaultTab: AppTab;
  languageOptions: Option<Locale>[];
  locale: Locale;
  onAutoRefreshUsageChange: (enabled: boolean) => void;
  onDefaultTabChange: (tab: AppTab) => void;
  onLocaleChange: (locale: Locale) => void;
  onRevealVault: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  status: AppStatus | null;
  t: Translate;
  theme: ThemeMode;
  themeOptions: Option<ThemeMode>[];
};

function SegmentedControl<T extends string>({
  ariaLabel,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  onChange: (value: T) => void;
  options: Option<T>[];
  value: T;
}) {
  return (
    <div className="settings-segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPanel({
  autoRefreshUsage,
  defaultTab,
  languageOptions,
  locale,
  onAutoRefreshUsageChange,
  onDefaultTabChange,
  onLocaleChange,
  onRevealVault,
  onThemeChange,
  status,
  t,
  theme,
  themeOptions,
}: SettingsPanelProps) {
  const tabOptions: Option<AppTab>[] = [
    { label: t("accountsTab"), value: "accounts" },
    { label: t("usageTab"), value: "usage" },
    { label: t("settingsTab"), value: "settings" },
  ];

  return (
    <div className="settings-page">
      <header className="page-heading">
        <span className="eyebrow">{t("preferences")}</span>
        <h2>{t("settingsTitle")}</h2>
        <p>{t("settingsDescription")}</p>
      </header>

      <div className="settings-grid">
        <section className="settings-group">
          <div className="settings-group-heading">
            <h3>{t("generalSettings")}</h3>
            <p>{t("generalSettingsHint")}</p>
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("appLanguage")}</strong>
              <span>{t("appLanguageHint")}</span>
            </div>
            <SegmentedControl
              ariaLabel={t("appLanguage")}
              options={languageOptions}
              value={locale}
              onChange={onLocaleChange}
            />
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("appearance")}</strong>
              <span>{t("appearanceHint")}</span>
            </div>
            <SegmentedControl
              ariaLabel={t("appearance")}
              options={themeOptions}
              value={theme}
              onChange={onThemeChange}
            />
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("defaultTab")}</strong>
              <span>{t("defaultTabHint")}</span>
            </div>
            <SegmentedControl
              ariaLabel={t("defaultTab")}
              options={tabOptions}
              value={defaultTab}
              onChange={onDefaultTabChange}
            />
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group-heading">
            <h3>{t("usageSettings")}</h3>
            <p>{t("usageSettingsHint")}</p>
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("autoRefreshUsage")}</strong>
              <span>{t("autoRefreshUsageHint")}</span>
            </div>
            <button
              type="button"
              className={`toggle${autoRefreshUsage ? " active" : ""}`}
              role="switch"
              aria-checked={autoRefreshUsage}
              aria-label={t("autoRefreshUsage")}
              onClick={() => onAutoRefreshUsageChange(!autoRefreshUsage)}
            >
              <span />
            </button>
          </div>
        </section>

        <section className="settings-group settings-data-group">
          <div className="settings-group-heading">
            <h3>{t("localData")}</h3>
            <p>{t("localDataHint")}</p>
          </div>

          <dl className="settings-paths">
            <div>
              <dt>{t("codexDirectory")}</dt>
              <dd>{status?.codexHome}</dd>
            </div>
            <div>
              <dt>{t("localVaultPath")}</dt>
              <dd>{status?.vaultPath}</dd>
            </div>
          </dl>

          <button
            type="button"
            className="button secondary compact"
            disabled={!status?.vaultPath}
            onClick={onRevealVault}
          >
            {t("openDirectory")}
          </button>

          <p className="settings-privacy-note">{t("credentialPrivacy")}</p>
        </section>
      </div>
    </div>
  );
}

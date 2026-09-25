import { isPublicDemo } from "./runtime";
import { useCallback, useEffect, useState } from "react";
import {
  CodexConfigChoice,
  CodexConfigKey,
  CodexContextMode,
  CodexManagedConfig,
  getCodexManagedConfig,
  setCodexConfigChoice,
  setCodexContextMode,
} from "./api";
import { localizeBackendError, Locale, Translate } from "./i18n";
import {
  GuideButton,
  GuideInvitation,
  PageGuide,
  usePageGuide,
} from "./PageGuide";

type Option = { label: string; value: string };

const CONFIG_TOML_KEYS: Record<CodexConfigKey, string> = {
  credentialStorage: "cli_auth_credentials_store",
  reasoningEffort: "model_reasoning_effort",
  reasoningSummary: "model_reasoning_summary",
  modelVerbosity: "model_verbosity",
  webSearch: "web_search",
};

function ConfigChoiceControl({
  customLabel,
  disabled,
  label,
  onChange,
  options,
  value,
}: {
  customLabel: string;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  options: Option[];
  value: string;
}) {
  const visibleOptions =
    value === "custom"
      ? [...options, { label: customLabel, value: "custom" }]
      : options;
  return (
    <div
      className="settings-segmented config-choice-control"
      role="group"
      aria-label={label}
    >
      {visibleOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          disabled={disabled || option.value === "custom"}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const choiceLine = (key: string, choice: CodexConfigChoice, t: Translate) => {
  if (choice.value === "default") {
    return `# ${key} ${t("configChoiceDefaultPreview")}`;
  }
  if (choice.value === "custom") {
    return `# ${key} ${t("configChoiceCustomPreview")}`;
  }
  return `${key} = "${choice.value}"`;
};

export function CodexConfigPanel({
  locale,
  onCredentialStorageChange,
  t,
}: {
  locale: Locale;
  onCredentialStorageChange: () => Promise<void>;
  t: Translate;
}) {
  const [config, setConfig] = useState<CodexManagedConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guideReady = !loading && savingKey === null && Boolean(config || error);
  const guide = usePageGuide({
    page: "config",
    variant: error ? "error" : "overview",
    ready: guideReady,
  });
  const guideSteps = error
    ? [
        {
          target: '[data-guide="config-error"]',
          title: t("configGuideErrorTitle"),
          description: t("configGuideErrorDescription"),
          interactive: true,
        },
      ]
    : [
        {
          target: '[data-guide="config-credentialStorage"]',
          title: t("configGuideStorageTitle"),
          description: t("configGuideStorageDescription"),
        },
        {
          target: '[data-guide="config-context"]',
          title: t("configGuideContextTitle"),
          description: t("configGuideContextDescription"),
        },
        {
          target: '[data-guide="config-reasoningEffort"]',
          title: t("configGuideOutputTitle"),
          description: t("configGuideOutputDescription"),
        },
        {
          target: '[data-guide="config-webSearch"]',
          title: t("configGuideSearchTitle"),
          description: t("configGuideSearchDescription"),
        },
      ];

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConfig(await getCodexManagedConfig());
    } catch (reason) {
      setError(
        localizeBackendError(
          reason instanceof Error ? reason.message : String(reason),
          locale,
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeChoice = async (key: CodexConfigKey, value: string) => {
    if (!config || config[key].value === value || value === "custom") return;
    setSavingKey(key);
    setError(null);
    try {
      const nextConfig = await setCodexConfigChoice(key, value);
      setConfig(nextConfig);
      if (key === "credentialStorage") {
        await onCredentialStorageChange();
      }
    } catch (reason) {
      setError(
        localizeBackendError(
          reason instanceof Error ? reason.message : String(reason),
          locale,
        ),
      );
    } finally {
      setSavingKey(null);
    }
  };

  const changeContext = async (mode: string) => {
    if (!config || mode === "custom" || config.context.mode === mode) return;
    setSavingKey("context");
    setError(null);
    try {
      const context = await setCodexContextMode(
        mode as Exclude<CodexContextMode, "custom">,
      );
      setConfig((current) => (current ? { ...current, context } : current));
    } catch (reason) {
      setError(
        localizeBackendError(
          reason instanceof Error ? reason.message : String(reason),
          locale,
        ),
      );
    } finally {
      setSavingKey(null);
    }
  };

  const contextOptions: Option[] = [
    { label: t("contextModeDefault"), value: "default" },
    { label: t("contextModeOneMillion"), value: "oneMillion" },
  ];

  const contextPreview = config
    ? [
        config.context.contextWindow === null
          ? `# model_context_window ${t("contextConfigValueNotSet")}`
          : `model_context_window = ${config.context.contextWindow}`,
        config.context.autoCompactTokenLimit === null
          ? `# model_auto_compact_token_limit ${t("contextConfigValueNotSet")}`
          : `model_auto_compact_token_limit = ${config.context.autoCompactTokenLimit}`,
      ].join("\n")
    : `# ${t("contextConfigLoading")}`;

  const row = (
    key: CodexConfigKey,
    title: string,
    hint: string,
    options: Option[],
  ) => (
    <div className="settings-row" data-guide={`config-${key}`}>
      <div>
        <strong>{title}</strong>
        <span>{hint}</span>
        <pre className="config-inline-preview">
          <code>
            {config
              ? choiceLine(CONFIG_TOML_KEYS[key], config[key], t)
              : `# ${t("contextConfigLoading")}`}
          </code>
        </pre>
      </div>
      <ConfigChoiceControl
        customLabel={t("contextModeCustom")}
        disabled={isPublicDemo || loading || savingKey !== null || !config}
        label={title}
        options={options}
        value={config?.[key].value ?? "default"}
        onChange={(value) => void changeChoice(key, value)}
      />
    </div>
  );

  return (
    <div className="settings-page config-page">
      <header className="page-heading page-heading-with-guide">
        <div>
          <span className="eyebrow">config.toml</span>
          <h2>{t("codexConfigPageTitle")}</h2>
          <p>{t("codexConfigPageDescription")}</p>
          <p>{t("configGuideSaveHint")}</p>
        </div>
        <GuideButton onClick={guide.start} disabled={!guideReady} t={t} />
      </header>
      {!error && <GuideInvitation guide={guide} t={t} />}

      {error && (
        <section
          className="alert error"
          data-guide="config-error"
          role="status"
        >
          <strong>{t("operationFailed")}</strong>
          <span>{error}</span>
          <button
            type="button"
            className="text-button"
            disabled={loading || savingKey !== null}
            onClick={() => void load()}
          >
            {t("configGuideReload")}
          </button>
        </section>
      )}

      <div className="settings-grid">
        <section className="settings-group">
          <div className="settings-group-heading">
            <h3>{t("configAccountAndContext")}</h3>
            <p>{t("configAccountAndContextHint")}</p>
          </div>
          {row(
            "credentialStorage",
            t("credentialStorageMode"),
            config?.credentialStorage.value === "file" ||
              config?.credentialStorage.value === "default"
              ? t("credentialStorageFileHint")
              : t("credentialStorageModeHint"),
            [
              { label: t("configUseDefault"), value: "default" },
              { label: t("credentialStorageFile"), value: "file" },
              { label: t("credentialStorageAuto"), value: "auto" },
              { label: t("credentialStorageKeyring"), value: "keyring" },
            ],
          )}
          <div className="settings-row" data-guide="config-context">
            <div>
              <strong>{t("contextWindow")}</strong>
              <span>{t("contextConfigPageHint")}</span>
              <pre className="config-inline-preview">
                <code>{contextPreview}</code>
              </pre>
            </div>
            <ConfigChoiceControl
              customLabel={t("contextModeCustom")}
              disabled={
                isPublicDemo || loading || savingKey !== null || !config
              }
              label={t("contextWindow")}
              options={contextOptions}
              value={config?.context.mode ?? "default"}
              onChange={(value) => void changeContext(value)}
            />
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group-heading">
            <h3>{t("configModelOutput")}</h3>
            <p>{t("configModelOutputHint")}</p>
          </div>
          {row(
            "reasoningEffort",
            t("reasoningEffort"),
            t("reasoningEffortHint"),
            [
              { label: t("configUseDefault"), value: "default" },
              { label: t("reasoningMinimal"), value: "minimal" },
              { label: t("reasoningLow"), value: "low" },
              { label: t("reasoningMedium"), value: "medium" },
              { label: t("reasoningHigh"), value: "high" },
              { label: t("reasoningXHigh"), value: "xhigh" },
            ],
          )}
          {row(
            "reasoningSummary",
            t("reasoningSummary"),
            t("reasoningSummaryHint"),
            [
              { label: t("configUseDefault"), value: "default" },
              { label: t("configAuto"), value: "auto" },
              { label: t("summaryConcise"), value: "concise" },
              { label: t("summaryDetailed"), value: "detailed" },
              { label: t("configNone"), value: "none" },
            ],
          )}
          {row("modelVerbosity", t("modelVerbosity"), t("modelVerbosityHint"), [
            { label: t("configUseDefault"), value: "default" },
            { label: t("reasoningLow"), value: "low" },
            { label: t("reasoningMedium"), value: "medium" },
            { label: t("reasoningHigh"), value: "high" },
          ])}
        </section>

        <section className="settings-group">
          <div className="settings-group-heading">
            <h3>{t("configTools")}</h3>
            <p>{t("configToolsHint")}</p>
          </div>
          {row("webSearch", t("webSearchMode"), t("webSearchModeHint"), [
            { label: t("configUseDefault"), value: "default" },
            { label: t("webSearchDisabled"), value: "disabled" },
            { label: t("webSearchCached"), value: "cached" },
            { label: t("webSearchIndexed"), value: "indexed" },
            { label: t("webSearchLive"), value: "live" },
          ])}
        </section>
      </div>
      <PageGuide guide={guide} steps={guideSteps} t={t} />
    </div>
  );
}

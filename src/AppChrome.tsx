import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppTab } from "./appTypes";
import type { Translate } from "./i18n";

const GITHUB_REPOSITORY_URL = "https://github.com/Mintimate/codex-auth-switch";
const APP_TABS: AppTab[] = ["accounts", "usage", "quota", "settings"];

function AppIcon() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true">
      <g transform="translate(91 123)">
        <path
          className="app-icon-ink"
          d="M535.801 633.267c4.043 5.917 11.052 9.428 8.283 48.187-.781 10.919-11.367 33.703-37.594 34.876-5.565.249-305.882.466-316.947-.239-64.213-4.088-172.073-65.674-170.05-202.591.352-23.808-.579-222.534 1.805-244.022 1.396-12.582 5.066-55.728 40.66-103.649 41.559-55.953 99.302-69.992 109.511-72.474 19.912-4.841 20.088-5.051 246.031-3.882 86.617.448 88.2-1.28 105.043 8.958 25.411 15.447 23.088 43.265 22.399 57.077-1.993 39.944-34.316 34.301-55.444 34.264-260.446-.45-260.419-.926-283.023.37-4.035.231-22.809 3.14-40.969 14.368-49.413 30.55-49.383 87.354-49.378 95.99.046 88.003-2.315 203.949-.599 220.997.937 9.31.219 24.218 16.487 51.287 20.03 33.328 58.226 41.303 58.562 41.408 13.76 4.313 39.197 2.47 298.923 3.034 24.811.054 35.045 4.379 46.3 17.041Z"
        />
        <path
          className="app-icon-accent"
          d="M686.017 430.492c-.371 54.839.402 54.859.532 54.982.886.837 1.048.893 65.952.884 61.752-.008 63.351-1.59 72.735 7.403 7.575 7.259 6.838 12.686 6.666 53.736-.103 24.493-23.513 24.508-26.395 24.51-117.281.075-117.649-.535-118.87.661-2.387 2.338 1.307 52.544-2.069 62.852-5.497 16.785-25.399 29.158-48.097 7.009-8.891-8.676-94.499-87.172-97.985-93.02-12.139-20.363 6.682-34.626 13.831-42.18 92.35-97.569 92.235-97.705 94.156-98.87 14.877-9.028 37.733-4.855 39.544 22.033Z"
        />
        <path
          className="app-icon-accent"
          d="M705.387 257.483c.079-62.054-3.836-69.452 16.136-78.928 4.94-2.343 17.463-1.687 22.793 2.222 6.896 5.056 6.345 5.579 97.816 103.059 4.263 4.544 15.325 14.188 13.656 27.699-1.229 9.956-4.937 12.628-43.498 49.747-65.287 62.848-66.24 63.073-73.897 64.88-6.221 1.469-22.386 4.469-31.776-14.708-3.064-6.259.37-62.975-2.16-65.903-1.074-1.242-1.39-1.226-92.956-1.247-30.734-.007-43.219 2.717-50.153-13.744-1.401-3.324-2.784-6.606-1.782-45.057.803-30.824 25.193-26.377 48.934-26.364 31.335.018 31.255-.015 40.001.055 4.404.036 53.162.429 55.057-.555.154-.08.136-.085 1.829-1.156Z"
        />
        <path
          className="app-icon-ink"
          d="M334.3 399.515c-.362 18.973-4.878 18.954-38.843 47.935-3.086 2.633-57.314 47.502-62.301 51.629-27.617 22.851-56.012-18.861-30.606-40.522 29.801-25.407 29.681-25.472 32.273-27.673 33.266-28.245 36.227-28.736 33.578-31.278-12.422-11.914-68.946-56.976-72.195-62.933-13.165-24.141 12.423-55.48 38.342-33.232 5.643 4.845 6.036 4.272 71.319 59.649 18.549 15.735 26.34 17.495 28.433 36.425Z"
        />
        <path
          className="app-icon-ink"
          d="M352.041 499.573c-.081-1.362-.721-12.203 2.829-16.813 1.814-2.355 6.189-7.88 14.682-8.763 2.244-.233 87.829-.078 93.966.04 8.716.167 21.347 8.447 18.306 25.524-1.929 10.833-12.674 15.472-15.327 15.925-7.491 1.28-7.53.336-94.994.317-8.966-.001-17.356-5.987-19.462-16.23Z"
        />
      </g>
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0 1 12 6.82c.85 0 1.71.11 2.51.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.86v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

function PrivacyModeIcon({ enabled }: { enabled: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.3 10s2.8-4.4 7.7-4.4 7.7 4.4 7.7 4.4-2.8 4.4-7.7 4.4S2.3 10 2.3 10Z" />
      <circle cx="10" cy="10" r="2.2" />
      {enabled && <path d="m3.3 3.3 13.4 13.4" />}
    </svg>
  );
}

function TabIcon({ tab }: { tab: AppTab }) {
  if (tab === "accounts") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="6.2" r="3" />
        <path d="M4.6 16.5c.5-3.1 2.3-4.8 5.4-4.8s4.9 1.7 5.4 4.8" />
      </svg>
    );
  }
  if (tab === "usage") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 16.5h14M5 14V9.8M10 14V4M15 14V7" />
      </svg>
    );
  }
  if (tab === "quota") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 10a7 7 0 1 1 14 0M10 10l3.6-3.2M4.2 14.8h11.6" />
        <circle cx="10" cy="10" r="1" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
    </svg>
  );
}

const tabLabel = (tab: AppTab, t: Translate) => {
  if (tab === "accounts") return t("accountsTab");
  if (tab === "usage") return t("usageTab");
  if (tab === "quota") return t("quotaTab");
  return t("settingsTab");
};

export function AppSidebar({
  activeTab,
  onTabChange,
  t,
}: {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  t: Translate;
}) {
  return (
    <aside className="app-sidebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <div className="brand-mark" aria-hidden="true">
          <AppIcon />
        </div>
        <div className="brand-copy">
          <h1>Codex Auth Switch</h1>
          <p>{t("tagline")}</p>
        </div>
      </div>

      <nav className="app-tabs" role="tablist" aria-label={t("mainNavigation")}>
        {APP_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            className={`${activeTab === tab ? "active" : ""}${tab === "settings" ? " settings-tab" : ""}`}
            aria-selected={activeTab === tab}
            aria-controls={`${tab}-panel`}
            onClick={() => onTabChange(tab)}
          >
            <TabIcon tab={tab} />
            <span>{tabLabel(tab, t)}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

export function WorkspaceToolbar({
  onError,
  onPrivateModeChange,
  privateMode,
  t,
}: {
  onError: (message: string) => void;
  onPrivateModeChange: (enabled: boolean) => void;
  privateMode: boolean;
  t: Translate;
}) {
  return (
    <header className="workspace-toolbar" data-tauri-drag-region>
      <div className="topbar-actions">
        <button
          type="button"
          className={`privacy-mode-button${privateMode ? " active" : ""}`}
          aria-label={t(
            privateMode ? "disablePrivateMode" : "enablePrivateMode",
          )}
          aria-pressed={privateMode}
          title={t(privateMode ? "disablePrivateMode" : "enablePrivateMode")}
          onClick={() => onPrivateModeChange(!privateMode)}
        >
          <PrivacyModeIcon enabled={privateMode} />
          <span>{t("privacyMode")}</span>
        </button>
        <button
          type="button"
          className="github-link"
          aria-label={t("github")}
          title={GITHUB_REPOSITORY_URL}
          onClick={() =>
            void openUrl(GITHUB_REPOSITORY_URL).catch((reason) =>
              onError(
                t("githubOpenFailed", {
                  message:
                    reason instanceof Error ? reason.message : String(reason),
                }),
              ),
            )
          }
        >
          <GitHubIcon />
        </button>
        <span className="unofficial">{t("localOnly")}</span>
      </div>
    </header>
  );
}

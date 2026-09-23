import { Channel, invoke } from "@tauri-apps/api/core";
import packageMetadata from "../package.json";
import pricingSnapshot from "./pricing-snapshot.json";

export type AccountSummary = {
  id: string;
  label: string;
  accountId: string;
  email: string | null;
  createdAt: number;
  updatedAt: number;
  active: boolean;
  pendingLogin?: boolean;
};

export type LoginMethod = "device" | "hosted";
export type HostedLoginError =
  | "unavailable"
  | "unsupported"
  | "portInUse"
  | "network"
  | "rateLimited"
  | "rejected"
  | "invalidResponse"
  | "storage"
  | "expired"
  | "cleanup"
  | "cancelled"
  | "busy"
  | "browser"
  | "clipboard";
export type HostedLoginStatus = {
  sessionId: string;
  phase:
    "preparing" | "waiting" | "saving" | "completed" | "failed" | "cancelled";
  error: HostedLoginError | null;
  profileId: string | null;
  cleanupPending: boolean;
};

export type AppStatus = {
  codexHome: string;
  vaultPath: string;
  storageMode: string;
  supported: boolean;
  activeAccountId: string | null;
  accounts: AccountSummary[];
};

export type SwitchPreference = "ask" | "switchOnly" | "restart";
export type SwitchStage = "checking" | "closing" | "switching" | "launching";
export type SwitchResult = {
  status: AppStatus;
  restart: "notRequested" | "notRunning" | "restarted" | "launchFailed";
};

export type SwitchVerification = {
  credentialFile:
    | "matched"
    | "different"
    | "unavailable"
    | "unsupported"
    | "pendingLogin"
    | "targetRemoved";
  desktop: "running" | "notRunning" | "unsupported" | "unavailable";
  checkedAt: number;
};

export type QuotaPoint = {
  profileId: string;
  queriedAt: number;
  bucketId: string;
  window: "primary" | "secondary";
  windowMinutes: number | null;
  usedPercent: number;
  resetsAt: number | null;
  source: "appServer" | "compatibility";
  planType: string | null;
};

export type QuotaHistory = {
  points: QuotaPoint[];
  retentionDays: number;
  maxPoints: number;
  maxProfilePoints: number;
};

export type LocalDiagnosticId =
  | "codexHome"
  | "config"
  | "liveAuth"
  | "credentialPermissions"
  | "vault"
  | "activationHistory"
  | "activeProfile"
  | "atomicResidue";

export type LocalDiagnosticCheck = {
  id: LocalDiagnosticId;
  outcome: string;
  level: "pass" | "info" | "warning" | "error";
  count?: number;
  value?: string;
};

export type LocalDiagnostics = {
  health: "healthy" | "attention" | "error";
  passCount: number;
  infoCount: number;
  warningCount: number;
  errorCount: number;
  generatedAt: number;
  checks: LocalDiagnosticCheck[];
};

export type CodexContextMode = "default" | "oneMillion" | "custom";

export type CodexContextConfig = {
  mode: CodexContextMode;
  contextWindow: number | null;
  autoCompactTokenLimit: number | null;
};

export type CodexConfigChoice = {
  value: string;
};

export type CodexManagedConfig = {
  credentialStorage: CodexConfigChoice;
  context: CodexContextConfig;
  reasoningEffort: CodexConfigChoice;
  reasoningSummary: CodexConfigChoice;
  modelVerbosity: CodexConfigChoice;
  webSearch: CodexConfigChoice;
};

export type CodexConfigKey =
  | "credentialStorage"
  | "reasoningEffort"
  | "reasoningSummary"
  | "modelVerbosity"
  | "webSearch";

export type DeviceLoginResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type AuthTransferPreparation = {
  qrDataUrl: string | null;
  qrError: string | null;
};

export type TokenBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type UsageWindow = {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
};

export type UsageResetCredits = {
  availableCount: number;
  expiresAt: number[];
};

export type QuotaBucket = {
  id: string;
  name: string | null;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
};

export type AccountUsageSummary = {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  dailyUsageBuckets: AccountUsageDailyBucket[];
};

export type AccountUsageDailyBucket = {
  startDate: string;
  tokens: number;
};

export type AccountQuota = {
  profileId: string;
  accountId: string;
  label: string;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  buckets: QuotaBucket[];
  resetCredits: UsageResetCredits | null;
  planType: string | null;
  officialUsage: AccountUsageSummary | null;
  source: "appServer" | "compatibility" | null;
  success: boolean;
  error: string | null;
  queriedAt: number;
  historyWarning?: string | null;
};

export type LocalUsageStats = {
  today: TokenBreakdown;
  sevenDays: TokenBreakdown;
  thirtyDays: TokenBreakdown;
  daily: {
    date: string;
    tokens: TokenBreakdown;
    byProvider?: { id: string; totalTokens: number }[];
  }[];
  byProvider?: {
    id: string;
    label: string;
    kind: ModelProviderKind;
    host?: string | null;
    tokens: TokenBreakdown;
  }[];
  byAccount: {
    accountId: string;
    label: string;
    tokens: TokenBreakdown;
  }[];
  unassigned: TokenBreakdown;
  filesScanned: number;
  eventsCount: number;
  generatedAt: number;
};

export type ModelPrice = {
  model: string;
  input: number;
  cachedInput: number | null;
  cacheWrite: number | null;
  output: number;
};

export type ModelPrices = {
  prices: ModelPrice[];
  updatedAt: number;
  sourceUrl: string;
  source: "bundled" | "cache" | "live";
  warning: "fetchFailed" | "cacheWriteFailed" | null;
};

export type ModelProviderKind = "openai" | "thirdParty" | "unattributed";
export type ModelProviderOption = {
  id: string;
  label: string;
  kind: ModelProviderKind;
};

export type ModelProviderState = {
  activeProvider: string | null;
  activeId: string;
  providers: ModelProviderOption[];
};

type UsageOverview = {
  quotas: AccountQuota[];
  local: LocalUsageStats;
};

export type AppUpdateStatus =
  "unsupported" | "upToDate" | "available" | "error";

export type AppUpdateSource = "github" | "cnb";

export type ProxyMode = "off" | "system" | "manual";

export type NetworkProxySettings = {
  mode: ProxyMode;
  proxyUrl: string;
  noProxy: string;
};

export const defaultNetworkProxySettings = (): NetworkProxySettings => ({
  mode: "system",
  proxyUrl: "",
  noProxy: "",
});

export type AppUpdateCheckResult = {
  status: AppUpdateStatus;
  currentVersion: string;
  version: string | null;
  body: string | null;
  date: string | null;
  reason: string | null;
};

const previewStatus: AppStatus = {
  codexHome: "/Users/demo/.codex",
  vaultPath:
    "/Users/demo/Library/Application Support/io.github.codexauthmanager.desktop/accounts.v1.json",
  storageMode: "file",
  supported: true,
  activeAccountId: "account-personal-8f2a",
  accounts: [
    {
      id: "account-personal-8f2a",
      label: "个人 Pro",
      accountId: "account-personal-8f2a",
      email: "me@example.com",
      createdAt: 1787529600,
      updatedAt: 1787529600,
      active: true,
    },
    {
      id: "account-work-13bd",
      label: "工作账号",
      accountId: "account-work-13bd",
      email: "work@example.com",
      createdAt: 1787529600,
      updatedAt: 1787529600,
      active: false,
    },
  ],
};

const tokens = (
  totalTokens: number,
  inputTokens = Math.round(totalTokens * 0.72),
  outputTokens = totalTokens - inputTokens,
): TokenBreakdown => ({
  inputTokens,
  cachedInputTokens: Math.round(inputTokens * 0.44),
  cacheWriteInputTokens: 0,
  outputTokens,
  reasoningOutputTokens: Math.round(outputTokens * 0.36),
  totalTokens,
});

const previewDailyTotals = [
  28140, 34780, 22560, 51620, 44320, 68940, 38510, 74280, 59320, 48120, 82640,
  69320, 91720, 76480,
];

const previewOfficialDailyUsage = Array.from({ length: 35 }, (_, index) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - (34 - index));
  const multiplier = index % 9 === 0 ? 0 : 650 + ((index * 137) % 900);
  return {
    startDate: date.toISOString().slice(0, 10),
    tokens: previewDailyTotals[index % previewDailyTotals.length] * multiplier,
  };
});

const previewQuotas: AccountQuota[] = [
  {
    profileId: "account-personal-8f2a",
    accountId: "account-personal-8f2a",
    label: "个人 Pro",
    primary: {
      usedPercent: 38,
      windowMinutes: 300,
      resetsAt: Math.floor(Date.now() / 1000) + 86 * 60,
    },
    secondary: {
      usedPercent: 64,
      windowMinutes: 10080,
      resetsAt: Math.floor(Date.now() / 1000) + 4 * 24 * 60 * 60,
    },
    buckets: [
      {
        id: "codex",
        name: null,
        primary: {
          usedPercent: 38,
          windowMinutes: 300,
          resetsAt: Math.floor(Date.now() / 1000) + 86 * 60,
        },
        secondary: {
          usedPercent: 64,
          windowMinutes: 10080,
          resetsAt: Math.floor(Date.now() / 1000) + 4 * 24 * 60 * 60,
        },
      },
      {
        id: "codex_bengalfox",
        name: "GPT-5.3-Codex-Spark",
        primary: {
          usedPercent: 12,
          windowMinutes: 300,
          resetsAt: Math.floor(Date.now() / 1000) + 142 * 60,
        },
        secondary: null,
      },
    ],
    resetCredits: {
      availableCount: 1,
      expiresAt: [Math.floor(Date.now() / 1000) + 21 * 24 * 60 * 60],
    },
    planType: "pro",
    officialUsage: {
      lifetimeTokens: 1567980267,
      peakDailyTokens: 375224027,
      longestRunningTurnSec: 45622,
      currentStreakDays: 11,
      longestStreakDays: 14,
      dailyUsageBuckets: previewOfficialDailyUsage,
    },
    source: "appServer",
    success: true,
    error: null,
    queriedAt: Math.floor(Date.now() / 1000),
  },
  {
    profileId: "account-work-13bd",
    accountId: "account-work-13bd",
    label: "工作账号",
    primary: {
      usedPercent: 17,
      windowMinutes: 300,
      resetsAt: Math.floor(Date.now() / 1000) + 128 * 60,
    },
    secondary: null,
    buckets: [],
    resetCredits: {
      availableCount: 0,
      expiresAt: [],
    },
    planType: null,
    officialUsage: null,
    source: "compatibility",
    success: true,
    error: null,
    queriedAt: Math.floor(Date.now() / 1000),
  },
];

const previewLocalUsage: LocalUsageStats = {
  today: tokens(76480),
  sevenDays: tokens(495880),
  thirtyDays: tokens(1842360),
  daily: previewDailyTotals.map((total, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (previewDailyTotals.length - index - 1));
    return {
      date: date.toISOString().slice(0, 10),
      byProvider: [
        { id: "openai", totalTokens: Math.round(total * 0.18) },
        { id: "provider:custom", totalTokens: Math.round(total * 0.82) },
      ],
      tokens: tokens(total),
    };
  }),
  byProvider: [
    {
      id: "openai",
      label: "OpenAI 默认提供方",
      kind: "openai",
      host: null,
      tokens: tokens(331_600),
    },
    {
      id: "provider:custom",
      label: "本地模型代理",
      kind: "thirdParty",
      host: "relay.example.com",
      tokens: tokens(1_510_760),
    },
  ],
  byAccount: [
    {
      accountId: "account-personal-8f2a",
      label: "个人 Pro",
      tokens: tokens(1124760),
    },
    {
      accountId: "account-work-13bd",
      label: "工作账号",
      tokens: tokens(615200),
    },
  ],
  unassigned: tokens(102400),
  filesScanned: 18,
  eventsCount: 146,
  generatedAt: Math.floor(Date.now() / 1000),
};

const previewModelProviderState: ModelProviderState = {
  activeProvider: "custom",
  activeId: "provider:custom",
  providers: [
    { id: "openai", label: "OpenAI 默认提供方", kind: "openai" },
    {
      id: "provider:custom",
      label: "本地模型代理",
      kind: "thirdParty",
    },
  ],
};

const previewDiagnostics: LocalDiagnostics = {
  health: "healthy",
  passCount: 8,
  infoCount: 0,
  warningCount: 0,
  errorCount: 0,
  generatedAt: Math.floor(Date.now() / 1000),
  checks: [
    { id: "codexHome", outcome: "ready", level: "pass" },
    { id: "config", outcome: "ready", level: "pass" },
    { id: "liveAuth", outcome: "ready", level: "pass" },
    { id: "credentialPermissions", outcome: "ready", level: "pass" },
    { id: "vault", outcome: "ready", level: "pass", count: 2 },
    { id: "activationHistory", outcome: "ready", level: "pass", count: 6 },
    { id: "activeProfile", outcome: "matched", level: "pass" },
    { id: "atomicResidue", outcome: "clean", level: "pass" },
  ],
};

let previewNetworkProxy = defaultNetworkProxySettings();

const previewCodexContextConfig: CodexContextConfig = {
  mode: "default",
  contextWindow: null,
  autoCompactTokenLimit: null,
};

const previewCodexManagedConfig: CodexManagedConfig = {
  credentialStorage: { value: "file" },
  context: previewCodexContextConfig,
  reasoningEffort: { value: "high" },
  reasoningSummary: { value: "auto" },
  modelVerbosity: { value: "medium" },
  webSearch: { value: "cached" },
};

const previewShareQr = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges">
    <rect width="29" height="29" fill="white"/>
    <path fill="#222" d="M2 2h7v7H2zm2 2v3h3V4zM20 2h7v7h-7zm2 2v3h3V4zM2 20h7v7H2zm2 2v3h3v-3zM12 2h2v2h-2zm3 0h2v4h-2zm-4 5h6v2h-6zm0 4h3v3h-3zm5 0h2v7h-2zm4 0h2v3h-2zm3 0h4v2h-4zm-1 4h5v2h-5zm-11 2h3v2h-3zm4 2h2v2h-2zm4 0h3v3h-3zm5 0h3v2h-3zm-13 4h6v2h-6zm8 1h2v3h-2zm4-1h4v4h-4z"/>
  </svg>
`)}`;

let previewHostedLogin: HostedLoginStatus | null = null;
let previewHistory: QuotaPoint[] = previewQuotas.flatMap((quota) => {
  const now = Math.floor(Date.now() / 1000);
  return (["primary", "secondary"] as const).flatMap((kind) => {
    const window = quota[kind];
    if (!window) return [];
    return Array.from({ length: 12 }, (_, index) => ({
      profileId: quota.profileId,
      queriedAt: now - (11 - index) * 1200,
      bucketId: "codex",
      window: kind,
      windowMinutes: window.windowMinutes,
      usedPercent:
        kind === "primary" && index < 5
          ? 65 + index * 5
          : Math.max(
              0,
              window.usedPercent -
                (11 - index) * (kind === "primary" ? 4 : 1.5),
            ),
      resetsAt: kind === "primary" && index < 5 ? now - 7800 : window.resetsAt,
      source: quota.source ?? "appServer",
      planType: quota.planType,
    }));
  });
});
let previewCacheBytes = 256 * 1024;

const isTauri = () => "__TAURI_INTERNALS__" in window;

const call = <T>(command: string, args?: Record<string, unknown>) => {
  if (import.meta.env.DEV && !isTauri()) {
    if (command === "get_quota_history")
      return Promise.resolve(
        structuredClone({
          points: previewHistory,
          retentionDays: 30,
          maxPoints: 12000,
          maxProfilePoints: 2000,
        }) as T,
      );
    if (command === "clear_quota_history") {
      previewHistory = [];
      return Promise.resolve(undefined as T);
    }
    if (command === "verify_account_switch") {
      const target = previewStatus.accounts.find(
        (account) => account.id === args?.profileId,
      );
      return Promise.resolve({
        credentialFile: !target
          ? "targetRemoved"
          : previewStatus.activeAccountId === target.accountId
            ? "matched"
            : "different",
        desktop: "running",
        checkedAt: Math.floor(Date.now() / 1000),
      } as T);
    }
    if (command === "start_hosted_login") {
      previewHostedLogin = {
        sessionId: "preview-hosted",
        phase: "waiting",
        error: null,
        profileId: null,
        cleanupPending: true,
      };
      return Promise.resolve(structuredClone(previewHostedLogin) as T);
    }
    if (command === "get_hosted_login")
      return Promise.resolve(structuredClone(previewHostedLogin) as T);
    if (command === "cancel_hosted_login") {
      if (previewHostedLogin)
        previewHostedLogin = {
          ...previewHostedLogin,
          phase: "cancelled",
          cleanupPending: false,
        };
      return Promise.resolve(structuredClone(previewHostedLogin) as T);
    }
    // 网页预览不启动登录、不打开授权地址。
    if (command === "open_hosted_login" || command === "copy_hosted_login")
      return Promise.reject("unavailable");
    if (command === "desktop_restart_supported")
      return Promise.resolve(true as T);
    if (
      command === "switch_account" ||
      command === "switch_account_with_options"
    ) {
      const target = previewStatus.accounts.find(
        (account) => account.id === args?.profileId,
      );
      if (!target) return Promise.reject(new Error("找不到指定账号"));
      previewStatus.activeAccountId = target.accountId;
      for (const account of previewStatus.accounts) {
        account.active = account.id === target.id;
      }
      return Promise.resolve(
        structuredClone(
          command === "switch_account"
            ? previewStatus
            : {
                status: previewStatus,
                restart: args?.restart ? "restarted" : "notRequested",
              },
        ) as T,
      );
    }
    if (command === "remove_account") {
      previewStatus.accounts = previewStatus.accounts.filter(
        (a) => a.id !== args?.profileId,
      );
      previewHistory = previewHistory.filter(
        (p) => p.profileId !== args?.profileId,
      );
      return Promise.resolve(
        structuredClone({
          status: previewStatus,
          historyCleanupFailed: false,
        }) as T,
      );
    }
    if (command === "start_device_login") {
      return Promise.resolve({
        deviceCode: "preview-device-code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresIn: 900,
        interval: 8,
      } as T);
    }
    if (command === "poll_device_login") {
      return Promise.resolve(null as T);
    }
    if (command === "get_usage_cache_info" || command === "clear_usage_cache") {
      if (command === "clear_usage_cache") previewCacheBytes = 0;
      return Promise.resolve({
        bytes: previewCacheBytes,
        maxBytes: 8 * 1024 * 1024,
      } as T);
    }
    if (command === "get_local_usage") {
      return Promise.resolve(structuredClone(previewLocalUsage) as T);
    }
    if (command === "get_model_prices") {
      return Promise.resolve(
        structuredClone({
          ...pricingSnapshot,
          sourceUrl: "https://developers.openai.com/api/docs/pricing",
          source: "bundled",
          warning: null,
        }) as T,
      );
    }
    if (command === "get_model_provider_state") {
      return Promise.resolve(structuredClone(previewModelProviderState) as T);
    }
    if (command === "get_account_quotas") {
      return Promise.resolve(structuredClone(previewQuotas) as T);
    }
    if (command === "get_usage_overview") {
      return Promise.resolve(
        structuredClone({
          quotas: previewQuotas,
          local: previewLocalUsage,
        }) as T,
      );
    }
    if (command === "get_local_diagnostics") {
      return Promise.resolve(structuredClone(previewDiagnostics) as T);
    }
    if (command === "get_network_proxy") {
      return Promise.resolve(structuredClone(previewNetworkProxy) as T);
    }
    if (command === "set_network_proxy") {
      const settings = (args?.settings ??
        defaultNetworkProxySettings()) as NetworkProxySettings;
      previewNetworkProxy = structuredClone(settings);
      return Promise.resolve(structuredClone(previewNetworkProxy) as T);
    }
    if (command === "get_codex_managed_config") {
      return Promise.resolve(structuredClone(previewCodexManagedConfig) as T);
    }
    if (command === "set_codex_context_mode") {
      const mode = args?.mode === "oneMillion" ? "oneMillion" : "default";
      const context: CodexContextConfig =
        mode === "oneMillion"
          ? {
              mode,
              contextWindow: 1_000_000,
              autoCompactTokenLimit: 900_000,
            }
          : previewCodexContextConfig;
      previewCodexManagedConfig.context = context;
      return Promise.resolve(structuredClone(context) as T);
    }
    if (command === "set_codex_config_choice") {
      const key = args?.key as CodexConfigKey;
      const value = typeof args?.value === "string" ? args.value : "default";
      if (key in previewCodexManagedConfig) {
        previewCodexManagedConfig[key] = { value };
        if (key === "credentialStorage") {
          previewStatus.storageMode = value === "default" ? "file" : value;
          previewStatus.supported = previewStatus.storageMode === "file";
        }
      }
      return Promise.resolve(structuredClone(previewCodexManagedConfig) as T);
    }
    if (command === "enable_file_credential_storage") {
      previewStatus.storageMode = "file";
      previewStatus.supported = true;
      previewCodexManagedConfig.credentialStorage = { value: "file" };
      return Promise.resolve(structuredClone(previewStatus) as T);
    }
    if (command === "prepare_auth_transfer") {
      return Promise.resolve({
        qrDataUrl: previewShareQr,
        qrError: null,
      } as T);
    }
    if (command === "get_app_version") {
      return Promise.resolve(packageMetadata.version as T);
    }
    if (command === "check_app_update") {
      return Promise.resolve({
        status: "upToDate",
        currentVersion: packageMetadata.version,
        version: null,
        body: null,
        date: null,
        reason: null,
      } as T);
    }
    if (command === "install_app_update") {
      return Promise.resolve(true as T);
    }
    if (command === "copy_auth_transfer") {
      return Promise.resolve(undefined as T);
    }
    return Promise.resolve(structuredClone(previewStatus) as T);
  }
  return invoke<T>(command, args);
};

export const getStatus = () => call<AppStatus>("get_status");

export const getLocalDiagnostics = () =>
  call<LocalDiagnostics>("get_local_diagnostics");

export const getCodexManagedConfig = () =>
  call<CodexManagedConfig>("get_codex_managed_config");

export const setCodexContextMode = (
  mode: Exclude<CodexContextMode, "custom">,
) => call<CodexContextConfig>("set_codex_context_mode", { mode });

export const enableFileCredentialStorage = () =>
  call<AppStatus>("enable_file_credential_storage");

export const setCodexConfigChoice = (key: CodexConfigKey, value: string) =>
  call<CodexManagedConfig>("set_codex_config_choice", { key, value });

const isMissingCommand = (error: unknown, command: string) => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.toLowerCase().includes("not found") && message.includes(command)
  );
};

const getLegacyUsageOverview = () => call<UsageOverview>("get_usage_overview");

export const getLocalUsage = async () => {
  try {
    return await call<LocalUsageStats>("get_local_usage");
  } catch (error) {
    if (!isMissingCommand(error, "get_local_usage")) throw error;
    return (await getLegacyUsageOverview()).local;
  }
};

export const getModelPrices = (refresh = false) =>
  call<ModelPrices>("get_model_prices", { refresh });

export const getModelProviderState = async () => {
  try {
    return await call<ModelProviderState>("get_model_provider_state");
  } catch (error) {
    if (!isMissingCommand(error, "get_model_provider_state")) throw error;
    return null;
  }
};

export const getAccountQuotas = async () => {
  try {
    return await call<AccountQuota[]>("get_account_quotas");
  } catch (error) {
    if (!isMissingCommand(error, "get_account_quotas")) throw error;
    return (await getLegacyUsageOverview()).quotas;
  }
};

export const refreshPreviewQuotas = async (
  profileIds: string[],
  onUpdate: (quota: AccountQuota) => void,
) => {
  if (import.meta.env.DEV && !isTauri()) {
    const results = structuredClone(
      previewQuotas.filter((quota) => profileIds.includes(quota.profileId)),
    );
    for (const quota of results) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      quota.queriedAt = Math.floor(Date.now() / 1000);
      for (const bucket of quota.buckets.length
        ? quota.buckets
        : [
            { id: "codex", primary: quota.primary, secondary: quota.secondary },
          ]) {
        for (const kind of ["primary", "secondary"] as const) {
          const window = bucket[kind];
          if (!window) continue;
          previewHistory = previewHistory.filter(
            (point) =>
              !(
                point.profileId === quota.profileId &&
                point.bucketId === bucket.id &&
                point.window === kind &&
                point.queriedAt === quota.queriedAt
              ),
          );
          previewHistory.push({
            profileId: quota.profileId,
            queriedAt: quota.queriedAt,
            bucketId: bucket.id,
            window: kind,
            windowMinutes: window.windowMinutes,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt,
            source: quota.source ?? "appServer",
            planType: quota.planType,
          });
        }
      }
      onUpdate(quota);
    }
    return results;
  }
  throw new Error("网页预览数据不可在桌面版查询");
};

export type UsageCacheInfo = { bytes: number; maxBytes: number };
export const getUsageCacheInfo = () =>
  call<UsageCacheInfo>("get_usage_cache_info");
export const clearUsageCache = () => call<UsageCacheInfo>("clear_usage_cache");

export const getAppVersion = () => call<string>("get_app_version");

export const checkAppUpdate = (source: AppUpdateSource) =>
  call<AppUpdateCheckResult>("check_app_update", { source });

export const installAppUpdate = () => call<boolean>("install_app_update");

export const saveCurrent = (label: string) =>
  call<AppStatus>("save_current", { label });

export const startHostedLogin = (label: string) =>
  call<HostedLoginStatus>("start_hosted_login", { label });
export const getHostedLogin = () =>
  call<HostedLoginStatus | null>("get_hosted_login");
export const cancelHostedLogin = (sessionId: string) =>
  call<HostedLoginStatus>("cancel_hosted_login", { sessionId });
export const openHostedLogin = (sessionId: string) =>
  call<void>("open_hosted_login", { sessionId });
export const copyHostedLogin = (sessionId: string) =>
  call<void>("copy_hosted_login", { sessionId });

export const startDeviceLogin = (label: string) =>
  call<DeviceLoginResponse>("start_device_login", { label });

export const pollDeviceLogin = (deviceCode: string) =>
  call<AppStatus | null>("poll_device_login", { deviceCode });

export const cancelDeviceLogin = (deviceCode: string) =>
  call<AppStatus>("cancel_device_login", { deviceCode });

export const switchAccount = (profileId: string) =>
  call<AppStatus>("switch_account", { profileId });

export const verifyAccountSwitch = (profileId: string) =>
  call<SwitchVerification>("verify_account_switch", { profileId });
export const getQuotaHistory = () => call<QuotaHistory>("get_quota_history");
export const clearQuotaHistory = () => call<void>("clear_quota_history");

export const desktopRestartSupported = () =>
  call<boolean>("desktop_restart_supported");

export const switchAccountWithOptions = (
  profileId: string,
  restart: boolean,
  onProgress: (stage: SwitchStage) => void,
) => {
  if (import.meta.env.DEV && !isTauri()) {
    onProgress("switching");
    return call<SwitchResult>("switch_account_with_options", {
      profileId,
      restart,
    });
  }
  const channel = new Channel<SwitchStage>();
  channel.onmessage = onProgress;
  return call<SwitchResult>("switch_account_with_options", {
    profileId,
    restart,
    onProgress: channel,
  });
};

export const renameAccount = (profileId: string, label: string) =>
  call<AppStatus>("rename_account", { profileId, label });

export const removeAccount = (profileId: string) =>
  call<{ status: AppStatus; historyCleanupFailed: boolean }>("remove_account", {
    profileId,
  });

export const copyAuthTransfer = (profileId: string) =>
  call<void>("copy_auth_transfer", { profileId });

// 读写共享队列，跨面板卸载也保持顺序；重新打开设置页会等待此前保存完成。
let networkProxyQueue: Promise<void> = Promise.resolve();
const queueNetworkProxy = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = networkProxyQueue.then(operation);
  networkProxyQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

export const getNetworkProxy = () =>
  queueNetworkProxy(() => call<NetworkProxySettings>("get_network_proxy"));

export const setNetworkProxy = (settings: NetworkProxySettings) =>
  queueNetworkProxy(() =>
    call<NetworkProxySettings>("set_network_proxy", { settings }),
  );

export const prepareAuthTransfer = (profileId: string) =>
  call<AuthTransferPreparation>("prepare_auth_transfer", { profileId });

export const importAuthFromClipboard = () =>
  call<AppStatus>("import_auth_from_clipboard");

// 二维码图片以 base64 字符串传输，不用 number[]：12MB 图片展开成 JSON 数组会产生
// 千万级元素，序列化和解析的开销都远大于传输本身。
export const importAuthFromQr = (image: string) =>
  call<AppStatus>("import_auth_from_qr", { image });

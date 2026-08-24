import { invoke } from "@tauri-apps/api/core";

export type AccountSummary = {
  id: string;
  label: string;
  accountId: string;
  email: string | null;
  createdAt: number;
  updatedAt: number;
  active: boolean;
};

export type AppStatus = {
  codexHome: string;
  vaultPath: string;
  storageMode: string;
  supported: boolean;
  activeAccountId: string | null;
  accounts: AccountSummary[];
};

export type DeviceLoginResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
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

export type AccountQuota = {
  profileId: string;
  accountId: string;
  label: string;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  success: boolean;
  error: string | null;
  queriedAt: number;
};

export type UsageOverview = {
  quotas: AccountQuota[];
  local: {
    today: TokenBreakdown;
    sevenDays: TokenBreakdown;
    thirtyDays: TokenBreakdown;
    daily: { date: string; tokens: TokenBreakdown }[];
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

const previewUsage: UsageOverview = {
  quotas: [
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
      success: true,
      error: null,
      queriedAt: Math.floor(Date.now() / 1000),
    },
  ],
  local: {
    today: tokens(76480),
    sevenDays: tokens(495880),
    thirtyDays: tokens(1842360),
    daily: previewDailyTotals.map((total, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (previewDailyTotals.length - index - 1));
      return {
        date: date.toISOString().slice(0, 10),
        tokens: tokens(total),
      };
    }),
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
  },
};

const previewShareQr = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges">
    <rect width="29" height="29" fill="white"/>
    <path fill="#222" d="M2 2h7v7H2zm2 2v3h3V4zM20 2h7v7h-7zm2 2v3h3V4zM2 20h7v7H2zm2 2v3h3v-3zM12 2h2v2h-2zm3 0h2v4h-2zm-4 5h6v2h-6zm0 4h3v3h-3zm5 0h2v7h-2zm4 0h2v3h-2zm3 0h4v2h-4zm-1 4h5v2h-5zm-11 2h3v2h-3zm4 2h2v2h-2zm4 0h3v3h-3zm5 0h3v2h-3zm-13 4h6v2h-6zm8 1h2v3h-2zm4-1h4v4h-4z"/>
  </svg>
`)}`;

const isTauri = () => "__TAURI_INTERNALS__" in window;

const call = <T>(command: string, args?: Record<string, unknown>) => {
  if (import.meta.env.DEV && !isTauri()) {
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
    if (command === "get_usage_overview") {
      return Promise.resolve(structuredClone(previewUsage) as T);
    }
    if (command === "get_auth_share_qr") {
      return Promise.resolve(previewShareQr as T);
    }
    if (command === "copy_auth_share") {
      return Promise.resolve(undefined as T);
    }
    return Promise.resolve(structuredClone(previewStatus) as T);
  }
  return invoke<T>(command, args);
};

export const getStatus = () => call<AppStatus>("get_status");

export const getUsageOverview = () => call<UsageOverview>("get_usage_overview");

export const saveCurrent = (label: string) =>
  call<AppStatus>("save_current", { label });

export const startDeviceLogin = (label: string) =>
  call<DeviceLoginResponse>("start_device_login", { label });

export const pollDeviceLogin = (
  deviceCode: string,
  userCode: string,
  label: string,
) =>
  call<AppStatus | null>("poll_device_login", {
    deviceCode,
    userCode,
    label,
  });

export const switchAccount = (profileId: string) =>
  call<AppStatus>("switch_account", { profileId });

export const renameAccount = (profileId: string, label: string) =>
  call<AppStatus>("rename_account", { profileId, label });

export const removeAccount = (profileId: string) =>
  call<AppStatus>("remove_account", { profileId });

export const copyAuthShare = (profileId: string) =>
  call<void>("copy_auth_share", { profileId });

export const getAuthShareQr = (profileId: string) =>
  call<string>("get_auth_share_qr", { profileId });

export const importAuthFromClipboard = () =>
  call<AppStatus>("import_auth_from_clipboard");

export const importAuthFromQr = (image: number[]) =>
  call<AppStatus>("import_auth_from_qr", { image });

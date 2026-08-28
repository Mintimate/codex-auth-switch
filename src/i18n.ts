import { useCallback, useLayoutEffect, useState } from "react";

export type Locale = "zh-CN" | "en";

const zhCN = {
  language: "语言",
  chinese: "中文",
  english: "English",
  light: "亮色",
  dark: "暗色",
  system: "跟随系统",
  appearance: "外观模式",
  pageDescription: "在本机保存和切换 Codex ChatGPT 登录配置",
  tagline: "本机 Codex 多账号切换器",
  localOnly: "纯本地 · 切换 Auth",
  mainNavigation: "主导航",
  accountsTab: "账号",
  usageTab: "Token 用量",
  settingsTab: "设置",
  github: "在 GitHub 查看项目仓库",
  githubOpenFailed: "无法打开 GitHub：{message}",
  loadingStatus: "正在读取本机 Codex 登录状态…",
  currentLogin: "当前登录",
  currentAccountUnsaved: "尚未保存当前账号",
  accountDetected: "已检测到账号 {id}",
  noChatGptLogin: "尚未检测到 ChatGPT 登录",
  loggedIn: "已登录",
  loggedOut: "未登录",
  saveCurrentLogin: "保存当前登录",
  loginNewAccount: "OAuth 添加账号",
  importAuth: "导入 Auth · 不推荐",
  flowEyebrow: "切换链路",
  flowTitle: "账号如何切换",
  flowDescription: "切换只发生在本机凭据文件，不代理 Codex 请求。",
  flowSavedAccounts: "已保存账号",
  flowSavedDetail: "本机账号库中有 {count} 个账号",
  flowSwitchDetail: "校验目标账号并执行切换",
  flowAuthFileDetail: "CODEX_HOME 中的当前凭据",
  flowCodexDetail: "后续请求使用新账号",
  flowCaptureTokens: "先保存当前令牌",
  flowAtomicReplace: "原子替换凭据",
  flowNextRequest: "下次请求生效",
  flowPrivacyNote:
    "账号快照和 auth.json 始终留在本机；应用不会读取提示词或代理会话请求。",
  unsupportedStorageTitle: "当前凭据存储模式不受支持",
  unsupportedStorage: "检测到 {mode}。请在 Codex config.toml 中设置",
  unknown: "未知",
  operationFailed: "操作失败",
  closeNotice: "关闭提示",
  close: "关闭",
  usageInsight: "用量洞察",
  preferences: "偏好设置",
  settingsTitle: "设置",
  settingsDescription: "调整界面、启动页面和本机用量查询行为。",
  generalSettings: "通用",
  generalSettingsHint: "这些偏好仅保存在当前设备。",
  appLanguage: "界面语言",
  appLanguageHint: "切换应用中的菜单、提示和日期格式。",
  appearanceHint: "选择亮色、暗色或跟随系统外观。",
  defaultTab: "默认页面",
  defaultTabHint: "设置应用下次启动时首先打开的页面。",
  usageSettings: "Token 用量",
  usageSettingsHint: "控制何时读取本机会话并查询在线额度窗口。",
  autoRefreshUsage: "进入页面时自动刷新",
  autoRefreshUsageHint: "打开 Token 用量页时自动更新统计和订阅窗口。",
  softwareUpdate: "软件更新",
  softwareUpdateHint: "从所选发布源检查并安装经过签名的更新。",
  updateSource: "更新源",
  updateSourceHint: "CNB 在 GitHub 发布完成后同步，可能稍有延迟。",
  currentVersion: "当前版本",
  loadingVersion: "正在读取版本…",
  checkForUpdates: "检查更新",
  checkingUpdate: "检查中…",
  appUpdateCheckingHint: "正在检查可用更新。",
  appUpdateAvailable: "发现新版本 v{version}",
  appUpdateUpToDate: "Codex Auth Switch 已是最新版本",
  appUpdateUnsupported: "开发构建不支持应用内更新",
  appUpdateCheckFailed: "检查更新失败",
  appUpdateInstallFailed: "下载或安装更新失败",
  appUpdateGitHubFallbackHint: "如果 GitHub 下载较慢，可以切换到 CNB 后重试。",
  installUpdate: "安装更新",
  appUpdateInstalling: "安装中…",
  appUpdateDownloading: "正在下载并校验更新…",
  appUpdateDownloadingProgress: "正在下载并校验更新… {progress}%",
  localData: "本地数据",
  localDataHint: "查看 Codex 目录和本应用的本机账号库位置。",
  localVault: "本机账号库",
  savedAccounts: "已保存账号",
  refresh: "刷新",
  current: "当前",
  emailUnavailable: "未提供邮箱",
  switchAccount: "切换账号",
  switchToAccount: "切换到此账号",
  shareAuth: "分享 Auth（不推荐）",
  share: "分享 · 不推荐",
  rename: "重命名",
  removeFromVault: "从本机账号库移除",
  remove: "移除",
  noSavedAccounts: "还没有保存账号",
  noSavedAccountsHint:
    "可以保存现有 Codex 登录，也可以通过浏览器授权添加新账号。",
  codexDirectory: "Codex 目录",
  localVaultPath: "本地账号库",
  revealVaultAria: "在文件管理器中打开本地账号库目录",
  revealVaultTitle: "在文件管理器中显示账号库文件",
  revealVaultFailed: "无法打开本地账号库目录：{message}",
  openDirectory: "打开目录",
  openCodexDirectory: "打开 Codex 目录",
  openVaultDirectory: "打开账号库目录",
  openCodexDirectoryFailed: "无法打开 Codex 目录：{message}",
  credentialPrivacy: "认证文件包含敏感令牌。应用不会上传、显示或写入日志。",
  busy: "{action}中…",
  pleaseWait: "请稍候",
  removeAccountTitle: "移除“{label}”？",
  removeAccountDescription:
    "这会删除该账号的本地保存副本，不会注销 ChatGPT 账号{activeSuffix}",
  activeRemoveSuffix: "，也不会中断当前 Codex 登录。",
  inactiveRemoveSuffix: "。",
  activeRemoveNote: "移除后将不能再从列表切换回该账号，除非重新保存当前登录。",
  cancel: "取消",
  removeLocalOnly: "仅从本机移除",
  authSharing: "Auth 分享 · 不推荐",
  shareAccountTitle: "分享“{label}”",
  shareDescription: "通过二维码或剪贴板把此账号的现有 Auth 迁移到另一台设备。",
  shareQrAlt: "{label} 的 Auth 分享二维码",
  qrGenerationFailed: "无法生成二维码",
  qrGenerating: "正在本机生成二维码…",
  shareWarning:
    "不建议跨设备分享 Auth：复用登录凭据可能导致 401。请优先在接收设备发起 OAuth 配对。分享载荷仍包含可登录凭据，请勿截图留存或发送给不受信任的人。",
  copiedHint: "已复制。粘贴完成后建议清空系统剪贴板。",
  done: "完成",
  copyAgain: "重新复制",
  copyToClipboard: "仍要复制",
  authImport: "Auth 导入 · 不推荐",
  chooseImportMethod: "选择导入方式",
  importDescription:
    "导入成功后会保存并切换账号。跨设备复用 Auth 可能导致 401，请优先使用 OAuth 添加账号。",
  importAndSwitch: "导入并切换 Auth",
  importClipboard: "从剪贴板导入",
  importClipboardHint: "读取本应用生成的 Auth 分享文本",
  importQr: "导入二维码图片",
  importQrHint: "选择 PNG、JPEG、WebP 或 GIF 图片",
  qrReadFailed: "无法读取二维码图片：{message}",
  importWarning:
    "仅导入来自可信来源的内容。分享载荷包含可登录凭据；应用会在 Rust 后端校验，原始令牌不会显示在界面或写入日志。",
  deviceCodeLogin: "OAuth 配对",
  completeLoginInBrowser: "在浏览器中完成登录",
  deviceLoginDescription:
    "打开下方地址并输入配对验证码。你也可以把地址和验证码提供给账号持有人；授权完成后，本设备会自动保存并切换账号。",
  browserUrl: "浏览器地址",
  pairingCode: "配对验证码",
  copyVerificationCode: "复制验证码",
  verificationCodeCopied: "验证码已复制",
  copyPairingDetails: "复制配对信息",
  pairingDetailsCopied: "浏览器地址和配对验证码已复制",
  pairingCopyFailed: "无法复制，请手动复制浏览器地址和配对验证码",
  pairingDetailsText: "浏览器地址：{url}\n配对验证码：{code}",
  waitingBrowser: "正在等待浏览器授权",
  deviceLoginHint:
    "配对码会自动过期，只应提供给预期的账号持有人。本流程不会导出已有登录凭据；如页面提示不可用，请先在 ChatGPT 安全设置中启用 Device Code 登录。",
  browserOpenFailed: "无法打开浏览器，请访问 auth.openai.com/codex/device",
  openLoginPage: "打开登录页面",
  browserLogin: "OAuth 配对",
  accountName: "账号名称",
  nameNewAccount: "为新账号设置名称",
  saveThisAccount: "保存这个账号",
  renameAccount: "重命名账号",
  displayName: "显示名称",
  accountNamePlaceholder: "例如：个人 Pro",
  deviceLoginNextStep:
    "下一步会生成浏览器地址和一次性配对码；可在本机授权，也可提供给账号持有人完成授权。",
  continue: "继续",
  workAccount: "工作账号",
  numberedAccount: "账号 {number}",
  requestLoginCode: "申请登录验证码",
  loginCodeExpired: "登录验证码已过期，请重新发起登录",
  newAccountSaved: "新账号登录并保存完成",
  renameAccountAction: "重命名账号",
  removeAccountAction: "移除账号",
  operationComplete: "{action}完成",
  qrTooLarge: "二维码图片不能超过 12 MB",
  quotaWindow: "额度窗口",
  hoursWindow: "{count} 小时窗口",
  daysWindow: "{count} 天窗口",
  minutesWindow: "{count} 分钟窗口",
  resetUnknown: "重置时间未知",
  resetsAt: "重置于 {date}",
  quotaUsed: "{window}已使用",
  localUsage30Days: "近 30 天本机归属用量",
  noLocalUsage: "暂无本机归属用量",
  noQuotaWindows: "当前账号没有返回可展示的额度窗口。",
  quotaQueryFailed: "额度查询失败",
  usageTitle: "Token 用量与订阅额度",
  usageDescription: "Token 来自本机会话，额度百分比来自在线窗口查询。",
  calculating: "统计中…",
  refreshUsage: "刷新用量",
  retry: "重试",
  usageLoading: "正在汇总本机 Token 并查询账号额度…",
  usageNotLoaded: "尚未读取用量数据",
  usageNotLoadedHint: "自动刷新已关闭。需要时可手动读取本机会话和订阅窗口。",
  loadUsage: "读取用量",
  today: "今天",
  last7Days: "近 7 天",
  last30Days: "近 30 天",
  trend14Days: "14 天趋势",
  usageEvents: "{count} 个用量事件",
  sessionFiles: "{count} 个会话文件",
  trendAria: "最近 14 天 Token 用量趋势",
  breakdown30Days: "近 30 天构成",
  breakdownHint: "缓存与推理为对应 Token 的子集",
  input: "输入",
  cachedInput: "缓存输入",
  output: "输出",
  reasoningOutput: "推理输出",
  accountUsageAndQuota: "账号归属与额度",
  accountUsageHint:
    "数字为近 30 天本机归属 Token，下方百分比为订阅窗口已用额度",
  unassignedHistory: "历史未归属 {tokens}",
  saveForQuota: "保存账号后即可查看订阅窗口。",
  usagePrivacy:
    "只提取会话中的 token_count 元数据，不解析提示词或回复正文。Token 数字不是订阅总额度；账号归属从本版本记录切换历史后开始生效。",
} as const;

type MessageKey = keyof typeof zhCN;
type Messages = Record<MessageKey, string>;

const en: Messages = {
  language: "Language",
  chinese: "中文",
  english: "English",
  light: "Light",
  dark: "Dark",
  system: "Use system setting",
  appearance: "Appearance",
  pageDescription: "Save and switch Codex ChatGPT logins locally",
  tagline: "Local Codex account switcher",
  localOnly: "Local only · Switch Auth",
  mainNavigation: "Main navigation",
  accountsTab: "Accounts",
  usageTab: "Token usage",
  settingsTab: "Settings",
  github: "View the project on GitHub",
  githubOpenFailed: "Could not open GitHub: {message}",
  loadingStatus: "Reading the local Codex login status…",
  currentLogin: "Current login",
  currentAccountUnsaved: "Current account is not saved",
  accountDetected: "Detected account {id}",
  noChatGptLogin: "No ChatGPT login detected",
  loggedIn: "Logged in",
  loggedOut: "Not logged in",
  saveCurrentLogin: "Save current login",
  loginNewAccount: "Add account with OAuth",
  importAuth: "Import Auth · Not recommended",
  flowEyebrow: "Switching path",
  flowTitle: "How account switching works",
  flowDescription:
    "Switching changes only the local credential file; Codex requests are never proxied.",
  flowSavedAccounts: "Saved accounts",
  flowSavedDetail: "{count} accounts in the local vault",
  flowSwitchDetail: "Validate the target account and switch",
  flowAuthFileDetail: "Current credentials in CODEX_HOME",
  flowCodexDetail: "Future requests use the new account",
  flowCaptureTokens: "Save current tokens first",
  flowAtomicReplace: "Atomically replace credentials",
  flowNextRequest: "Takes effect on the next request",
  flowPrivacyNote:
    "Account snapshots and auth.json stay on this device. The app never reads prompts or proxies session requests.",
  unsupportedStorageTitle: "Unsupported credential storage mode",
  unsupportedStorage:
    "Detected {mode}. Set the following in Codex config.toml:",
  unknown: "unknown",
  operationFailed: "Operation failed",
  closeNotice: "Dismiss notification",
  close: "Close",
  usageInsight: "Usage insight",
  preferences: "Preferences",
  settingsTitle: "Settings",
  settingsDescription:
    "Adjust the interface, startup page, and local usage query behavior.",
  generalSettings: "General",
  generalSettingsHint: "These preferences are stored only on this device.",
  appLanguage: "Interface language",
  appLanguageHint: "Change menus, messages, and date formatting.",
  appearanceHint: "Use the light, dark, or system appearance.",
  defaultTab: "Default page",
  defaultTabHint: "Choose the page shown when the app starts.",
  usageSettings: "Token usage",
  usageSettingsHint:
    "Control when local sessions and online quota windows are queried.",
  autoRefreshUsage: "Refresh when opened",
  autoRefreshUsageHint:
    "Update statistics and subscription windows when opening Token usage.",
  softwareUpdate: "Software update",
  softwareUpdateHint:
    "Check for and install signed updates from the selected release source.",
  updateSource: "Update source",
  updateSourceHint:
    "CNB syncs after the GitHub release completes and may lag briefly.",
  currentVersion: "Current version",
  loadingVersion: "Loading version…",
  checkForUpdates: "Check for updates",
  checkingUpdate: "Checking…",
  appUpdateCheckingHint: "Checking for available updates.",
  appUpdateAvailable: "Version v{version} is available",
  appUpdateUpToDate: "Codex Auth Switch is up to date",
  appUpdateUnsupported: "In-app updates are unavailable in development builds",
  appUpdateCheckFailed: "Failed to check for updates",
  appUpdateInstallFailed: "Failed to download or install the update",
  appUpdateGitHubFallbackHint:
    "If GitHub is downloading slowly, switch to CNB and try again.",
  installUpdate: "Install update",
  appUpdateInstalling: "Installing…",
  appUpdateDownloading: "Downloading and verifying the update…",
  appUpdateDownloadingProgress:
    "Downloading and verifying the update… {progress}%",
  localData: "Local data",
  localDataHint: "View the Codex directory and this app's local account vault.",
  localVault: "Local account vault",
  savedAccounts: "Saved accounts",
  refresh: "Refresh",
  current: "Current",
  emailUnavailable: "Email unavailable",
  switchAccount: "Switch account",
  switchToAccount: "Switch to this account",
  shareAuth: "Share Auth (not recommended)",
  share: "Share · Not recommended",
  rename: "Rename",
  removeFromVault: "Remove from the local account vault",
  remove: "Remove",
  noSavedAccounts: "No saved accounts yet",
  noSavedAccountsHint:
    "Save the current Codex login or add an account through browser authorization.",
  codexDirectory: "Codex directory",
  localVaultPath: "Local account vault",
  revealVaultAria: "Open the local account vault directory in the file manager",
  revealVaultTitle: "Reveal the account vault file in the file manager",
  revealVaultFailed:
    "Could not open the local account vault directory: {message}",
  openDirectory: "Open folder",
  openCodexDirectory: "Open Codex folder",
  openVaultDirectory: "Open vault folder",
  openCodexDirectoryFailed: "Could not open the Codex directory: {message}",
  credentialPrivacy:
    "Authentication files contain sensitive tokens. The app never uploads, displays, or logs them.",
  busy: "{action}…",
  pleaseWait: "Please wait",
  removeAccountTitle: "Remove “{label}”?",
  removeAccountDescription:
    "This deletes the locally saved copy of this account. It does not sign out the ChatGPT account{activeSuffix}",
  activeRemoveSuffix: " or interrupt the current Codex login.",
  inactiveRemoveSuffix: ".",
  activeRemoveNote:
    "You will not be able to switch back to this account from the list unless you save the current login again.",
  cancel: "Cancel",
  removeLocalOnly: "Remove locally",
  authSharing: "Auth sharing · Not recommended",
  shareAccountTitle: "Share “{label}”",
  shareDescription:
    "Move this account's existing Auth to another device through a QR code or the clipboard.",
  shareQrAlt: "Auth sharing QR code for {label}",
  qrGenerationFailed: "Could not generate the QR code",
  qrGenerating: "Generating the QR code locally…",
  shareWarning:
    "Sharing Auth across devices is not recommended because reusing credentials may cause 401 errors. Prefer starting OAuth pairing on the receiving device. The payload still contains login credentials; do not retain screenshots or send it to untrusted people.",
  copiedHint: "Copied. Clear the system clipboard after pasting.",
  done: "Done",
  copyAgain: "Copy again",
  copyToClipboard: "Copy anyway",
  authImport: "Auth import · Not recommended",
  chooseImportMethod: "Choose an import method",
  importDescription:
    "Importing saves and switches the account. Reusing Auth across devices may cause 401 errors; prefer adding the account with OAuth.",
  importAndSwitch: "Import and switch Auth",
  importClipboard: "Import from clipboard",
  importClipboardHint: "Read Auth sharing text generated by this app",
  importQr: "Import a QR code image",
  importQrHint: "Choose a PNG, JPEG, WebP, or GIF image",
  qrReadFailed: "Could not read the QR code image: {message}",
  importWarning:
    "Only import content from a trusted source. The payload contains login credentials; the Rust backend validates it, and raw tokens are never displayed or logged.",
  deviceCodeLogin: "OAuth pairing",
  completeLoginInBrowser: "Complete login in your browser",
  deviceLoginDescription:
    "Open the URL below and enter the pairing code. You can also send both to the account owner; this device saves and switches to the account after authorization.",
  browserUrl: "Browser URL",
  pairingCode: "Pairing code",
  copyVerificationCode: "Copy verification code",
  verificationCodeCopied: "Verification code copied",
  copyPairingDetails: "Copy pairing details",
  pairingDetailsCopied: "Browser URL and pairing code copied",
  pairingCopyFailed:
    "Could not copy. Copy the browser URL and pairing code manually.",
  pairingDetailsText: "Browser URL: {url}\nPairing code: {code}",
  waitingBrowser: "Waiting for browser authorization",
  deviceLoginHint:
    "The pairing code expires automatically and should only be sent to the intended account owner. This flow never exports stored credentials. If unavailable, enable Device Code login in ChatGPT security settings.",
  browserOpenFailed:
    "Could not open the browser. Visit auth.openai.com/codex/device",
  openLoginPage: "Open login page",
  browserLogin: "OAuth pairing",
  accountName: "Account name",
  nameNewAccount: "Name the new account",
  saveThisAccount: "Save this account",
  renameAccount: "Rename account",
  displayName: "Display name",
  accountNamePlaceholder: "For example: Personal Pro",
  deviceLoginNextStep:
    "The next step generates a browser URL and one-time pairing code. Authorize locally or send them to the account owner.",
  continue: "Continue",
  workAccount: "Work account",
  numberedAccount: "Account {number}",
  requestLoginCode: "Requesting login code",
  loginCodeExpired: "The login code expired. Start the login flow again.",
  newAccountSaved: "New account logged in and saved",
  renameAccountAction: "Rename account",
  removeAccountAction: "Remove account",
  operationComplete: "Completed: {action}",
  qrTooLarge: "The QR code image must not exceed 12 MB",
  quotaWindow: "Quota window",
  hoursWindow: "{count}-hour window",
  daysWindow: "{count}-day window",
  minutesWindow: "{count}-minute window",
  resetUnknown: "Reset time unavailable",
  resetsAt: "Resets {date}",
  quotaUsed: "{window} used",
  localUsage30Days: "Attributed local usage, last 30 days",
  noLocalUsage: "No attributed local usage",
  noQuotaWindows:
    "No displayable quota windows were returned for this account.",
  quotaQueryFailed: "Quota query failed",
  usageTitle: "Token usage and subscription quotas",
  usageDescription:
    "Tokens come from local sessions; percentages come from online quota windows.",
  calculating: "Calculating…",
  refreshUsage: "Refresh usage",
  retry: "Retry",
  usageLoading: "Summarizing local tokens and querying account quotas…",
  usageNotLoaded: "Usage data has not been loaded",
  usageNotLoadedHint:
    "Automatic refresh is off. Load local sessions and subscription windows when needed.",
  loadUsage: "Load usage",
  today: "Today",
  last7Days: "Last 7 days",
  last30Days: "Last 30 days",
  trend14Days: "14-day trend",
  usageEvents: "{count} usage events",
  sessionFiles: "{count} session files",
  trendAria: "Token usage trend over the last 14 days",
  breakdown30Days: "30-day breakdown",
  breakdownHint:
    "Cached and reasoning tokens are subsets of their respective totals",
  input: "Input",
  cachedInput: "Cached input",
  output: "Output",
  reasoningOutput: "Reasoning output",
  accountUsageAndQuota: "Account attribution and quotas",
  accountUsageHint:
    "Numbers are locally attributed tokens from the last 30 days; percentages show subscription quota used",
  unassignedHistory: "Unassigned history {tokens}",
  saveForQuota: "Save an account to view its subscription windows.",
  usagePrivacy:
    "Only token_count metadata is extracted from sessions; prompts and responses are never parsed. Token counts are not total subscription quotas. Account attribution starts after this version records switching history.",
};

const messages: Record<Locale, Messages> = { "zh-CN": zhCN, en };
const LOCALE_STORAGE_KEY = "codex-auth-switch-locale";

const initialLocale = (): Locale => {
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === "zh-CN" || stored === "en") return stored;
  return window.navigator.language.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en";
};

export type Translate = (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string;

export const useI18n = () => {
  const [locale, setLocale] = useState<Locale>(initialLocale);

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", messages[locale].pageDescription);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  const t = useCallback<Translate>(
    (key, values) => {
      let message = messages[locale][key];
      if (!values) return message;
      for (const [name, value] of Object.entries(values)) {
        message = message.replaceAll(`{${name}}`, String(value));
      }
      return message;
    },
    [locale],
  );

  return { locale, setLocale, t };
};

const backendErrorTranslations: Record<string, string> = {
  无法访问系统剪贴板: "Could not access the system clipboard",
  无法写入系统剪贴板: "Could not write to the system clipboard",
  无法读取系统剪贴板中的文本: "Could not read text from the system clipboard",
  分享内容无效或已损坏: "The shared content is invalid or corrupted",
  分享内容超过允许大小: "The shared content exceeds the size limit",
  "此账号的分享内容超过单个二维码容量，请改用剪贴板":
    "This account's shared content exceeds one QR code. Use the clipboard instead.",
  二维码图片无效或尺寸过大: "The QR code image is invalid or too large",
  "图片中未识别到有效的 Auth 分享二维码":
    "No valid Auth sharing QR code was found in the image",
  生成分享二维码失败: "Could not generate the sharing QR code",
  找不到指定账号: "The selected account could not be found",
  "登录验证码已过期，请重新发起登录":
    "The login code expired. Start the login flow again.",
  账号名称不能为空: "The account name cannot be empty",
  "账号名称不能超过 60 个字符": "The account name cannot exceed 60 characters",
  "当前不是 ChatGPT 订阅登录，API Key 登录不会被保存":
    "The current login is not a ChatGPT subscription login. API Key logins are not saved.",
  "Codex auth.json 缺少 tokens": "Codex auth.json is missing tokens",
  "无法识别当前 ChatGPT 账号 ID":
    "Could not identify the current ChatGPT account ID",
  账号缺少可用的访问凭据: "The account has no usable access credentials",
  "订阅凭据已失效，请重新登录该账号":
    "The subscription credentials expired. Log in to this account again.",
  额度查询失败: "Quota query failed",
  额度查询超时: "The quota query timed out",
  无法连接额度服务: "Could not connect to the quota service",
  额度查询网络失败: "The quota query failed due to a network error",
  额度服务返回了无法识别的响应:
    "The quota service returned an unrecognized response",
  无法定位用户主目录: "Could not locate the user home directory",
  登录服务返回了无法识别的设备码响应:
    "The login service returned an unrecognized device code response",
  登录服务返回的设备码不完整:
    "The login service returned an incomplete device code",
  "登录验证码状态无效，请重新发起登录":
    "The login code state is invalid. Start the login flow again.",
  登录服务返回了无法识别的授权响应:
    "The login service returned an unrecognized authorization response",
  无法初始化额度查询: "Could not initialize the quota query",
  "账号缺少 refresh_token": "The account is missing refresh_token",
  登录服务返回了无法识别的刷新响应:
    "The login service returned an unrecognized refresh response",
  "刷新响应缺少 access_token，请重新登录":
    "The refresh response is missing access_token. Log in again.",
  请求超时: "The request timed out",
  无法连接登录服务: "Could not connect to the login service",
  网络请求失败: "The network request failed",
  登录服务返回了无法识别的凭据响应:
    "The login service returned an unrecognized credential response",
  "登录响应缺少 refresh_token，请重新登录":
    "The login response is missing refresh_token. Log in again.",
  "登录响应缺少 id_token，请重新登录":
    "The login response is missing id_token. Log in again.",
  "登录响应缺少 access_token，请重新登录":
    "The login response is missing access_token. Log in again.",
  "无法从登录凭据中识别 ChatGPT 账号 ID":
    "Could not identify the ChatGPT account ID from the login credentials",
};

const backendErrorPatterns: Array<[RegExp, (...matches: string[]) => string]> =
  [
    [
      /^当前 Codex 凭据存储模式为 (.+)；请先在 config\.toml 中设置 cli_auth_credentials_store = "file"$/,
      (mode) =>
        `The current Codex credential storage mode is ${mode}. Set cli_auth_credentials_store = "file" in config.toml first.`,
    ],
    [
      /^无法定位应用数据目录: (.+)$/,
      (detail) => `Could not locate the application data directory: ${detail}`,
    ],
    [
      /^申请登录验证码失败（HTTP (.+)），请稍后重试$/,
      (status) =>
        `Could not request a login code (HTTP ${status}). Try again later.`,
    ],
    [
      /^检查登录状态失败（HTTP (.+)），请稍后重试$/,
      (status) =>
        `Could not check the login status (HTTP ${status}). Try again later.`,
    ],
    [
      /^额度服务暂不可用（HTTP (.+)）$/,
      (status) => `The quota service is unavailable (HTTP ${status}).`,
    ],
    [
      /^刷新订阅凭据失败（HTTP (.+)），请重新登录$/,
      (status) =>
        `Could not refresh the subscription credentials (HTTP ${status}). Log in again.`,
    ],
    [
      /^交换登录凭据失败（HTTP (.+)），请重新登录$/,
      (status) =>
        `Could not exchange login credentials (HTTP ${status}). Log in again.`,
    ],
    [
      /^Codex auth\.json 缺少 (.+)$/,
      (field) => `Codex auth.json is missing ${field}`,
    ],
    [
      /^不支持的账号库版本 (.+)$/,
      (version) => `Unsupported account vault version ${version}`,
    ],
    [
      /^Codex config\.toml 格式错误: (.+)$/,
      (detail) => `Invalid Codex config.toml: ${detail}`,
    ],
    [
      /^(.+) 格式错误: (.+)$/,
      (description, detail) => `Invalid ${description}: ${detail}`,
    ],
    [
      /^读取 (.+) 失败: (.+)$/,
      (target, detail) => `Could not read ${target}: ${detail}`,
    ],
    [
      /^(申请登录验证码|检查登录状态|刷新订阅凭据|交换登录凭据)失败：(请求超时|无法连接登录服务|网络请求失败)$/,
      (action, detail) => {
        const actions: Record<string, string> = {
          申请登录验证码: "request the login code",
          检查登录状态: "check the login status",
          刷新订阅凭据: "refresh the subscription credentials",
          交换登录凭据: "exchange login credentials",
        };
        return `Could not ${actions[action]}: ${backendErrorTranslations[detail] ?? detail}`;
      },
    ],
    [
      /^序列化认证数据失败: (.+)$/,
      (detail) => `Could not serialize authentication data: ${detail}`,
    ],
    [
      /^无法定位 (.+) 的父目录$/,
      (path) => `Could not locate the parent directory of ${path}`,
    ],
    [
      /^创建目录 (.+) 失败: (.+)$/,
      (path, detail) => `Could not create directory ${path}: ${detail}`,
    ],
    [
      /^写入临时认证文件失败: (.+)$/,
      (detail) =>
        `Could not write the temporary authentication file: ${detail}`,
    ],
    [
      /^同步临时认证文件失败: (.+)$/,
      (detail) => `Could not sync the temporary authentication file: ${detail}`,
    ],
    [
      /^创建临时认证文件失败: (.+)$/,
      (detail) =>
        `Could not create the temporary authentication file: ${detail}`,
    ],
    [
      /^原子替换 (.+) 失败: (.+)$/,
      (path, detail) => `Could not atomically replace ${path}: ${detail}`,
    ],
    [
      /^清理旧认证备份失败: (.+)$/,
      (detail) => `Could not remove the old authentication backup: ${detail}`,
    ],
    [
      /^创建认证备份失败: (.+)$/,
      (detail) => `Could not create the authentication backup: ${detail}`,
    ],
    [
      /^替换认证文件失败: (.+)$/,
      (detail) => `Could not replace the authentication file: ${detail}`,
    ],
    [
      /^设置目录 (.+) 权限失败: (.+)$/,
      (path, detail) =>
        `Could not set permissions for directory ${path}: ${detail}`,
    ],
  ];

export const localizeBackendError = (message: string, locale: Locale) => {
  if (locale === "zh-CN") return message;
  const exact = backendErrorTranslations[message];
  if (exact) return exact;
  for (const [pattern, translate] of backendErrorPatterns) {
    const match = message.match(pattern);
    if (match) return translate(...match.slice(1));
  }
  return message;
};

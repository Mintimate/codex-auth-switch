import { useCallback, useLayoutEffect, useState } from "react";

export type Locale = "zh-CN" | "en";

const zhCN = {
  chinese: "中文",
  english: "English",
  light: "亮色",
  dark: "暗色",
  system: "跟随系统",
  appearance: "外观模式",
  privacyMode: "私密模式",
  privacyModeHint: "隐藏界面中的邮箱地址，方便截图、录屏或分享屏幕。",
  enablePrivateMode: "开启私密模式",
  disablePrivateMode: "关闭私密模式",
  emailHidden: "邮箱已隐藏",
  pageDescription: "在本机保存和切换 Codex ChatGPT 登录配置",
  tagline: "本机 Codex 多账号切换器",
  localOnly: "纯本地 · 切换 Auth",
  mainNavigation: "主导航",
  accountsTab: "账号",
  usageTab: "Token 用量",
  quotaTab: "订阅额度",
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
  saveCurrentLogin: "保存当前账号",
  saveCurrentLoginHint: "保存当前 Codex 登录，方便以后切换",
  loginNewAccount: "登录新账号",
  loginNewAccountHint: "推荐 · 通过浏览器安全授权（OAuth）",
  importAuth: "导入一次性迁移 Auth",
  importAuthHint: "仅用于本应用生成的迁移内容",
  accountAddGuideLabel: "第一次添加账号？",
  accountAddGuide:
    "建议选择“登录新账号”：先设置一个本机名称，再到浏览器登录要添加的 ChatGPT 账号并输入一次性验证码。应用不会要求你填写密码，授权完成后会自动保存并切换。",
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
  settingsDescription: "调整界面、隐私、启动页面和本机用量查询行为。",
  generalSettings: "通用",
  generalSettingsHint: "这些偏好仅保存在当前设备。",
  appLanguage: "界面语言",
  appLanguageHint: "切换应用中的菜单、提示和日期格式。",
  appearanceHint: "选择亮色、暗色或跟随系统外观。",
  defaultTab: "默认页面",
  defaultTabHint: "设置应用下次启动时首先打开的页面。",
  usageSettings: "用量与额度",
  usageSettingsHint: "控制何时读取本机会话或查询在线订阅额度。",
  autoRefreshUsage: "进入页面时自动刷新",
  autoRefreshUsageHint: "打开 Token 用量或订阅额度页时刷新对应数据。",
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
  shareAuth: "一次性迁移 Auth",
  share: "迁移",
  rename: "重命名",
  removeFromVault: "从本机账号库移除",
  remove: "移除",
  noSavedAccounts: "还没有保存账号",
  noSavedAccountsHint:
    "可以保存现有 Codex 登录，也可以通过浏览器授权添加新账号。",
  codexDirectory: "Codex 目录",
  localVaultPath: "本地账号库",
  revealVaultFailed: "无法打开本地账号库目录：{message}",
  openCodexDirectory: "打开 Codex 目录",
  openVaultDirectory: "打开账号库目录",
  openCodexDirectoryFailed: "无法打开 Codex 目录：{message}",
  credentialPrivacy: "认证文件包含敏感令牌。应用不会上传、显示或写入日志。",
  localDiagnostics: "本地环境体检",
  localDiagnosticsHint:
    "由 Rust 在本机校验 Codex 配置、认证文件、账号库和切换安全状态。",
  runLocalDiagnostics: "重新体检",
  runningLocalDiagnostics: "体检中…",
  localDiagnosticsFailed: "无法完成本地环境体检",
  diagnosticsHealthy: "本地环境状态良好",
  diagnosticsAttention: "发现需要留意的项目",
  diagnosticsError: "发现需要处理的问题",
  diagnosticsSummary: "{pass} 项通过 · {warning} 项提醒 · {error} 项异常",
  diagnosticsCheckedAt: "检查于 {date}",
  diagnosticsPrivacy:
    "体检完全在本机进行，只返回检查状态和计数，不返回令牌、账号 ID 或文件内容。",
  diagnosticCodexHome: "Codex 目录",
  diagnosticConfig: "凭据存储配置",
  diagnosticLiveAuth: "当前认证文件",
  diagnosticCredentialPermissions: "认证文件权限",
  diagnosticVault: "本机账号库",
  diagnosticActivationHistory: "账号切换历史",
  diagnosticActiveProfile: "当前账号匹配",
  diagnosticAtomicResidue: "原子替换残留",
  diagnosticReady: "检查通过。",
  diagnosticReadyCount: "检查通过，共 {count} 项记录。",
  diagnosticMissingHome: "Codex 目录不存在。",
  diagnosticNotDirectory: "配置路径不是目录。",
  diagnosticUnreadable: "本机文件无法读取或超过安全检查大小限制。",
  diagnosticDefaultConfig: "未显式设置，当前使用兼容的 file 默认模式。",
  diagnosticInvalidConfig: "config.toml 格式无效。",
  diagnosticUnsupportedConfig: "当前凭据存储模式不支持本地切换。",
  diagnosticMissingAuth: "尚未发现当前认证文件。",
  diagnosticApiKeyAuth: "当前为 API Key 登录，不会加入订阅账号库。",
  diagnosticInvalidAuth: "认证结构无效或缺少必要字段。",
  diagnosticNotApplicable: "当前没有需要检查的数据。",
  diagnosticPermissionUnavailable: "无法确认认证文件权限。",
  diagnosticPermissionTooOpen: "发现 {count} 个权限范围过宽或符号链接路径。",
  diagnosticPlatformPermissions: "文件访问权限由当前平台管理。",
  diagnosticMissingVault: "账号库尚未创建。",
  diagnosticInvalidVault: "账号库格式无效。",
  diagnosticUnsupportedVault: "账号库版本 {value} 暂不受支持。",
  diagnosticInconsistentVault: "发现 {count} 个账号记录身份不一致。",
  diagnosticEmptyVault: "账号库为空。",
  diagnosticUnavailable: "依赖数据不可用，已跳过此项。",
  diagnosticEmptyHistory: "尚未记录账号切换历史。",
  diagnosticInconsistentHistory: "发现 {count} 个顺序或账号引用异常。",
  diagnosticActiveMatched: "当前登录与账号库记录一致。",
  diagnosticActiveUnsaved: "当前订阅账号尚未保存到本机账号库。",
  diagnosticAtomicClean: "未发现中断写入留下的临时文件。",
  diagnosticAtomicFound: "发现 {count} 个原子替换残留文件。",
  diagnosticUnknown: "返回了无法识别的检查状态。",
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
  authSharing: "一次性迁移 Auth",
  shareAccountTitle: "迁移“{label}”",
  shareDescription:
    "先停止在发送端使用此账号，再强制刷新凭据并生成精简的一次性迁移内容。二维码与剪贴板将复用同一份 CAS3 内容。",
  shareQrAlt: "{label} 的一次性迁移二维码",
  qrGenerationFailed: "无法生成二维码",
  transferPreparationFailed: "准备迁移失败",
  beforeTransferTitle: "先停止在发送端使用此账号",
  beforeTransferHint:
    "请退出发送端的 Codex 桌面端、CLI 和 IDE 扩展，并确认之后不会再次切换到此账号。",
  qrGenerating: "正在刷新凭据并准备一次性迁移…",
  prepareTransfer: "刷新并准备迁移",
  preparingTransfer: "正在强制刷新…",
  shareWarning:
    "迁移内容包含可登录凭据。接收端导入时会立即刷新并接管更新后的凭据，同一份内容只应导入一次。成功后请勿再在发送端使用此账号，否则后续令牌轮换仍可能导致 401。请勿截图留存或交给不受信任的人。",
  copiedHint:
    "已复制同一份 CAS3 迁移内容。接收端导入成功后，请清空剪贴板，并停止在发送端使用此账号。",
  done: "完成",
  copyAgain: "再次复制同一份",
  copyToClipboard: "复制迁移内容",
  authImport: "导入一次性迁移 Auth",
  chooseImportMethod: "选择导入方式",
  importDescription:
    "导入需要联网：应用会先立即刷新迁移凭据，校验账号并重建完整 Auth，成功后才保存和切换。同一份内容只应导入一次；需要两端长期使用时，请改用 OAuth 添加账号。",
  importAndSwitch: "导入迁移并切换",
  importClipboard: "从剪贴板读取",
  importClipboardHint: "读取本应用生成的一次性迁移文本",
  importQr: "选择迁移二维码",
  importQrHint: "选择本应用生成的 PNG、JPEG、WebP 或 GIF 图片",
  qrReadFailed: "无法读取二维码图片：{message}",
  importWarning:
    "仅导入来自可信来源的内容。抢先或重复导入可能使迁移内容失效；应用只在 Rust 后端兑换和校验，原始令牌不会显示在界面或写入日志。",
  deviceCodeLogin: "添加新账号",
  completeLoginInBrowser: "在浏览器中完成授权",
  deviceLoginDescription:
    "打开下方地址并输入一次性验证码。请登录要添加的 ChatGPT 账号；也可以把地址和验证码提供给账号持有人完成。授权后会自动保存并切换。",
  browserUrl: "浏览器地址",
  pairingCode: "一次性验证码",
  copyVerificationCode: "复制验证码",
  deviceCodeClickToCopy: "点击验证码即可复制",
  verificationCodeCopied: "验证码已复制",
  copyPairingDetails: "复制配对信息",
  pairingDetailsCopied: "浏览器地址和配对验证码已复制",
  pairingCopyFailed: "无法复制，请手动复制浏览器地址和配对验证码",
  pairingDetailsText: "浏览器地址：{url}\n配对验证码：{code}",
  waitingBrowser: "正在等待你在浏览器中完成授权…",
  deviceLoginHint:
    "配对码会自动过期，只应提供给预期的账号持有人。本流程不会导出已有登录凭据；如页面提示不可用，请先在 ChatGPT 安全设置中启用 Device Code 登录。",
  browserOpenFailed: "无法打开浏览器，请访问 auth.openai.com/codex/device",
  openLoginPage: "打开浏览器并授权",
  browserLogin: "添加新账号",
  accountName: "账号名称",
  nameNewAccount: "先给新账号起个名称",
  saveThisAccount: "保存当前账号",
  renameAccount: "重命名账号",
  displayName: "本机显示名称",
  accountNamePlaceholder: "例如：个人 Pro",
  deviceLoginNextStep:
    "这个名称只显示在本机。下一步会生成一次性验证码，并打开浏览器授权页面。",
  requestLoginCodeButton: "下一步：获取验证码",
  loginFlowEyebrow: "浏览器授权（OAuth）",
  loginFlowTitle: "新账号如何添加",
  loginFlowDescription:
    "应用会生成一次性验证码；你只需在浏览器登录要添加的 ChatGPT 账号并确认授权。",
  loginSceneAria:
    "小猫演示浏览器授权登录：获取一次性验证码、在浏览器确认、自动保存并切换账号。",
  loginSceneBrowser: "浏览器授权",
  loginSceneSaved: "账号已保存",
  loginSceneStepCode: "1 获取验证码",
  loginSceneStepAuthorize: "2 浏览器授权",
  loginSceneStepSaved: "3 自动保存",
  switchSceneAria:
    "小猫演示本地账号切换：选择已保存账号、替换本地凭据，并在 Codex 下次请求时生效。",
  switchSceneSaved: "已保存账号",
  switchSceneSwitching: "本地切换",
  switchSceneComplete: "切换完成",
  switchSceneStepSelect: "1 选择账号",
  switchSceneStepReplace: "2 替换凭据",
  switchSceneStepReady: "3 下次请求生效",
  loginFlowPairing: "配对信息",
  loginFlowPairingDetail: "生成登录地址和一次性验证码",
  loginFlowBrowser: "浏览器授权",
  loginFlowBrowserDetail: "登录要添加的 ChatGPT 账号并确认",
  loginFlowAuthFileDetail: "授权完成后自动保存在本机",
  loginFlowCodex: "Codex CLI 与 Codex",
  loginFlowCodexDetail: "自动切换到新账号",
  loginFlowContinue: "点击按钮后生成",
  loginFlowAuthorized: "完成授权后",
  loginFlowSharedAuth:
    "在同一个 CODEX_HOME 下，Codex CLI 与 Codex 读取同一份 auth.json，因此会共享当前登录态。",
  loginFlowPrivacyNote:
    "本应用不会要求你填写 ChatGPT 密码，也不会上传已有账号的登录凭据。",
  continue: "继续",
  workAccount: "工作账号",
  numberedAccount: "账号 {number}",
  requestLoginCode: "获取登录验证码",
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
  availableResetCredits: "可用完整重置",
  resetCreditCount: "{count} 次",
  resetCreditExpiresAt: "最早于 {date} 过期",
  quotaUsed: "{window}已使用",
  localUsage30Days: "近 30 天本机归属用量",
  noLocalUsage: "暂无本机归属用量",
  noQuotaWindows: "当前账号没有返回可展示的额度窗口。",
  quotaQueryFailed: "额度查询失败",
  usageTitle: "本机 Token 用量",
  usageDescription: "从本机会话元数据汇总使用趋势，不访问在线订阅额度。",
  calculating: "统计中…",
  refreshUsage: "刷新用量",
  retry: "重试",
  usageLoading: "正在汇总本机会话中的 Token 元数据…",
  usageNotLoaded: "尚未读取用量数据",
  usageNotLoadedHint: "自动刷新已关闭。需要时可手动读取本机会话。",
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
  accountAttribution: "账号归属",
  accountAttributionHint: "根据本机记录的账号切换时间归属近 30 天 Token",
  usageShare: "占 {percent}%",
  unassignedHistory: "历史未归属 {tokens}",
  saveForQuota: "保存账号后即可查看订阅窗口。",
  usagePrivacy:
    "只提取会话中的 token_count 元数据，不解析提示词或回复正文。Token 数字不是订阅总额度；账号归属从本版本记录切换历史后开始生效。",
  quotaOverview: "额度总览",
  quotaTitle: "订阅额度",
  quotaDescription: "比较已保存账号的额度窗口、恢复时间与完整重置有效期。",
  quotaSceneAria:
    "额度补给路线：当前账号 {account}，最高窗口已用 {percent}，{recovery}恢复，可用完整重置 {credits} 次。",
  quotaSceneCurrent: "当前账号",
  quotaSceneWindow: "额度槽",
  quotaSceneRecovery: "最近恢复",
  quotaSceneCredits: "完整重置",
  quotaSceneNoAccount: "暂无可用账号",
  quotaScenePatrolling: "猫咪正在巡检额度",
  quotaSceneReady: "额度补给路线",
  queryingQuota: "查询中…",
  refreshQuota: "刷新额度",
  quotaLoading: "正在查询账号订阅额度…",
  quotaNotLoaded: "尚未查询订阅额度",
  quotaNotLoadedHint: "自动刷新已关闭。需要时可手动查询所有已保存账号。",
  loadQuota: "查询额度",
  queryableAccounts: "查询成功",
  queryableAccountsHint: "成功返回额度的已保存账号",
  mostAvailableAccount: "额度最充足",
  highestWindowUsed: "最高窗口已用 {percent}%",
  nextQuotaRecovery: "下一次恢复",
  noneSoon: "暂无",
  noResetSchedule: "没有返回未来重置时间",
  earliestCreditExpiry: "最早于 {date} 过期",
  noCreditExpiry: "暂无可用完整重置",
  accountQuotaStatus: "账号额度状态",
  accountQuotaStatusHint: "当前账号优先，其余按最高窗口使用率排列",
  currentAccount: "当前登录账号",
  savedAccount: "已保存账号",
  quotaHealthy: "充足",
  quotaAttention: "注意",
  quotaTight: "紧张",
  quotaUnavailable: "不可用",
  quotaUnknown: "未知",
  quotaResetDetail: "{relative}恢复 · {date}",
  quotaWindowRecovers: "{window}恢复",
  resetCreditWillExpire: "完整重置过期",
  quotaQueriedAt: "查询于 {date}",
  quotaTimeline: "恢复时间轴",
  quotaTimelineHint: "按时间查看窗口恢复与完整重置过期",
  noQuotaEvents: "当前没有可展示的未来额度事件。",
  quotaPrivacy:
    "订阅额度直接从 ChatGPT 兼容性接口查询，只返回窗口、重置次数与时间；认证令牌不会进入前端或日志。",
} as const;

export type MessageKey = keyof typeof zhCN;
type Messages = Record<MessageKey, string>;

const en: Messages = {
  chinese: "中文",
  english: "English",
  light: "Light",
  dark: "Dark",
  system: "Use system setting",
  appearance: "Appearance",
  privacyMode: "Private mode",
  privacyModeHint:
    "Hide email addresses in the interface for screenshots, recordings, and screen sharing.",
  enablePrivateMode: "Enable private mode",
  disablePrivateMode: "Disable private mode",
  emailHidden: "Email hidden",
  pageDescription: "Save and switch Codex ChatGPT logins locally",
  tagline: "Local Codex account switcher",
  localOnly: "Local only · Switch Auth",
  mainNavigation: "Main navigation",
  accountsTab: "Accounts",
  usageTab: "Token usage",
  quotaTab: "Subscription quotas",
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
  saveCurrentLoginHint: "Add the current login to the local vault",
  loginNewAccount: "Log in to another account",
  loginNewAccountHint: "Recommended · Authorize in your browser",
  importAuth: "Import one-time Auth transfer",
  importAuthHint: "Transfer content generated by this app only",
  accountAddGuideLabel: "Adding an account for the first time?",
  accountAddGuide:
    "Choose “Log in to another account”, set a local name, then sign in to the ChatGPT account you want to add and enter the one-time code in your browser. The account is saved and selected automatically after authorization.",
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
    "Adjust privacy, the interface, startup page, and local usage query behavior.",
  generalSettings: "General",
  generalSettingsHint: "These preferences are stored only on this device.",
  appLanguage: "Interface language",
  appLanguageHint: "Change menus, messages, and date formatting.",
  appearanceHint: "Use the light, dark, or system appearance.",
  defaultTab: "Default page",
  defaultTabHint: "Choose the page shown when the app starts.",
  usageSettings: "Usage and quotas",
  usageSettingsHint:
    "Control when local sessions or online subscription quotas are queried.",
  autoRefreshUsage: "Refresh when opened",
  autoRefreshUsageHint:
    "Refresh the corresponding data when opening Token usage or Subscription quotas.",
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
  shareAuth: "One-time Auth transfer",
  share: "Transfer",
  rename: "Rename",
  removeFromVault: "Remove from the local account vault",
  remove: "Remove",
  noSavedAccounts: "No saved accounts yet",
  noSavedAccountsHint:
    "Save the current Codex login or add an account through browser authorization.",
  codexDirectory: "Codex directory",
  localVaultPath: "Local account vault",
  revealVaultFailed:
    "Could not open the local account vault directory: {message}",
  openCodexDirectory: "Open Codex folder",
  openVaultDirectory: "Open vault folder",
  openCodexDirectoryFailed: "Could not open the Codex directory: {message}",
  credentialPrivacy:
    "Authentication files contain sensitive tokens. The app never uploads, displays, or logs them.",
  localDiagnostics: "Local environment health",
  localDiagnosticsHint:
    "Rust checks Codex configuration, authentication files, the account vault, and switch safety locally.",
  runLocalDiagnostics: "Run again",
  runningLocalDiagnostics: "Checking…",
  localDiagnosticsFailed: "Could not complete the local environment check",
  diagnosticsHealthy: "Local environment is healthy",
  diagnosticsAttention: "Some items need attention",
  diagnosticsError: "Some problems need to be resolved",
  diagnosticsSummary: "{pass} passed · {warning} warnings · {error} errors",
  diagnosticsCheckedAt: "Checked {date}",
  diagnosticsPrivacy:
    "The check runs entirely on this device and returns only statuses and counts—never tokens, account IDs, or file contents.",
  diagnosticCodexHome: "Codex directory",
  diagnosticConfig: "Credential storage configuration",
  diagnosticLiveAuth: "Current authentication file",
  diagnosticCredentialPermissions: "Authentication file permissions",
  diagnosticVault: "Local account vault",
  diagnosticActivationHistory: "Account switch history",
  diagnosticActiveProfile: "Current account match",
  diagnosticAtomicResidue: "Atomic replacement residue",
  diagnosticReady: "Check passed.",
  diagnosticReadyCount: "Check passed with {count} records.",
  diagnosticMissingHome: "The Codex directory does not exist.",
  diagnosticNotDirectory: "The configured path is not a directory.",
  diagnosticUnreadable:
    "The local file could not be read or exceeds the safe inspection size limit.",
  diagnosticDefaultConfig:
    "No explicit setting; the compatible file mode default is active.",
  diagnosticInvalidConfig: "config.toml is invalid.",
  diagnosticUnsupportedConfig:
    "The current credential storage mode does not support local switching.",
  diagnosticMissingAuth: "No current authentication file was found.",
  diagnosticApiKeyAuth:
    "The current login uses an API key and is kept separate from the subscription account vault.",
  diagnosticInvalidAuth:
    "The authentication structure is invalid or missing required fields.",
  diagnosticNotApplicable: "There is currently no data to inspect.",
  diagnosticPermissionUnavailable:
    "Authentication file permissions could not be verified.",
  diagnosticPermissionTooOpen:
    "Found {count} paths with broad permissions or symbolic links.",
  diagnosticPlatformPermissions:
    "File access permissions are managed by this platform.",
  diagnosticMissingVault: "The account vault has not been created yet.",
  diagnosticInvalidVault: "The account vault format is invalid.",
  diagnosticUnsupportedVault: "Account vault version {value} is not supported.",
  diagnosticInconsistentVault:
    "Found {count} account records with inconsistent identities.",
  diagnosticEmptyVault: "The account vault is empty.",
  diagnosticUnavailable:
    "Required data is unavailable; this check was skipped.",
  diagnosticEmptyHistory: "No account switch history has been recorded yet.",
  diagnosticInconsistentHistory:
    "Found {count} ordering or account-reference problems.",
  diagnosticActiveMatched:
    "The current login matches a record in the account vault.",
  diagnosticActiveUnsaved:
    "The current subscription account has not been saved to the local vault.",
  diagnosticAtomicClean:
    "No temporary files from interrupted writes were found.",
  diagnosticAtomicFound:
    "Found {count} files left behind by atomic replacement.",
  diagnosticUnknown: "The check returned an unrecognized status.",
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
  authSharing: "One-time Auth transfer",
  shareAccountTitle: "Transfer “{label}”",
  shareDescription:
    "Stop using this account on the sending device, then force-refresh its credentials and create a compact one-time transfer. The QR code and clipboard reuse the same CAS3 content.",
  shareQrAlt: "One-time Auth transfer QR code for {label}",
  qrGenerationFailed: "Could not generate the QR code",
  transferPreparationFailed: "Could not prepare the transfer",
  beforeTransferTitle: "Stop using the sending device first",
  beforeTransferHint:
    "Exit the Codex desktop app, CLI, and IDE extension on the sending device, and do not switch back to this account afterward.",
  qrGenerating: "Refreshing credentials and preparing the transfer…",
  prepareTransfer: "Refresh and prepare transfer",
  preparingTransfer: "Force-refreshing…",
  shareWarning:
    "The transfer contains login credentials. Import immediately refreshes them and hands control to the receiver; use the same content only once. After success, stop using this account on the sending device, or later rotation may still cause 401 errors. Do not retain screenshots or share it with untrusted people.",
  copiedHint:
    "Copied the same CAS3 transfer. After import, clear the clipboard and stop using this account on the sending device.",
  done: "Done",
  copyAgain: "Copy the same transfer again",
  copyToClipboard: "Copy transfer content",
  authImport: "Import one-time Auth transfer",
  chooseImportMethod: "Choose an import method",
  importDescription:
    "Import requires a network connection: the app immediately refreshes the transfer credentials, verifies the account, rebuilds a complete Auth, and only then saves and switches. Use the content once; use OAuth when both devices need ongoing access.",
  importAndSwitch: "Import transfer and switch",
  importClipboard: "Import from clipboard",
  importClipboardHint: "Read one-time transfer text generated by this app",
  importQr: "Import a QR code image",
  importQrHint: "Choose a PNG, JPEG, WebP, or GIF image",
  qrReadFailed: "Could not read the QR code image: {message}",
  importWarning:
    "Only import content from a trusted source. An earlier or repeated import may invalidate it; the Rust backend alone redeems and validates it, and raw tokens are never displayed or logged.",
  deviceCodeLogin: "OAuth pairing",
  completeLoginInBrowser: "Complete login in your browser",
  deviceLoginDescription:
    "Open the URL below and enter the pairing code. You can also send both to the account owner; this device saves and switches to the account after authorization.",
  browserUrl: "Browser URL",
  pairingCode: "Pairing code",
  copyVerificationCode: "Copy verification code",
  deviceCodeClickToCopy: "Select the code to copy it",
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
    "The next step generates a one-time code and opens the OpenAI login page.",
  requestLoginCodeButton: "Next: get verification code",
  loginFlowEyebrow: "OAuth login path",
  loginFlowTitle: "How the new account signs in",
  loginFlowDescription:
    "The authorization result is written to the current CODEX_HOME without a relay service.",
  loginSceneAria:
    "A cat demonstrates browser authorization: get a one-time code, authorize in the browser, then save and switch accounts automatically.",
  loginSceneBrowser: "Browser authorization",
  loginSceneSaved: "Account saved",
  loginSceneStepCode: "1 Get code",
  loginSceneStepAuthorize: "2 Authorize",
  loginSceneStepSaved: "3 Save automatically",
  switchSceneAria:
    "A cat demonstrates local account switching: select a saved account, replace local credentials, and use them on the next Codex request.",
  switchSceneSaved: "Saved account",
  switchSceneSwitching: "Local switch",
  switchSceneComplete: "Switch complete",
  switchSceneStepSelect: "1 Select account",
  switchSceneStepReplace: "2 Replace credentials",
  switchSceneStepReady: "3 Ready next request",
  loginFlowPairing: "Pairing details",
  loginFlowPairingDetail: "Browser address and one-time verification code",
  loginFlowBrowser: "Browser authorization",
  loginFlowBrowserDetail: "Complete locally or by the account holder",
  loginFlowAuthFileDetail: "Written to the current CODEX_HOME",
  loginFlowCodex: "Codex CLI and Codex",
  loginFlowCodexDetail: "Share the same sign-in state",
  loginFlowContinue: "Generated after continuing",
  loginFlowAuthorized: "Authorization completed",
  loginFlowSharedAuth:
    "Within the same CODEX_HOME, Codex CLI and Codex read the same auth.json and share the current sign-in state.",
  loginFlowPrivacyNote:
    "This process does not export or share credentials for accounts already saved on this device.",
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
  availableResetCredits: "Full resets available",
  resetCreditCount: "{count}",
  resetCreditExpiresAt: "Earliest expiry {date}",
  quotaUsed: "{window} used",
  localUsage30Days: "Attributed local usage, last 30 days",
  noLocalUsage: "No attributed local usage",
  noQuotaWindows:
    "No displayable quota windows were returned for this account.",
  quotaQueryFailed: "Quota query failed",
  usageTitle: "Local Token usage",
  usageDescription:
    "Summarized from local session metadata without querying online subscription quotas.",
  calculating: "Calculating…",
  refreshUsage: "Refresh usage",
  retry: "Retry",
  usageLoading: "Summarizing Token metadata from local sessions…",
  usageNotLoaded: "Usage data has not been loaded",
  usageNotLoadedHint:
    "Automatic refresh is off. Load local sessions when needed.",
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
  accountAttribution: "Account attribution",
  accountAttributionHint:
    "Last 30 days of Tokens attributed from locally recorded account switches",
  usageShare: "{percent}% share",
  unassignedHistory: "Unassigned history {tokens}",
  saveForQuota: "Save an account to view its subscription windows.",
  usagePrivacy:
    "Only token_count metadata is extracted from sessions; prompts and responses are never parsed. Token counts are not total subscription quotas. Account attribution starts after this version records switching history.",
  quotaOverview: "Quota overview",
  quotaTitle: "Subscription quotas",
  quotaDescription:
    "Compare saved accounts by quota windows, recovery times, and full-reset expiry.",
  quotaSceneAria:
    "Quota supply route: current account {account}, highest window {percent} used, recovery {recovery}, and {credits} full resets available.",
  quotaSceneCurrent: "Current account",
  quotaSceneWindow: "Quota gauge",
  quotaSceneRecovery: "Next recovery",
  quotaSceneCredits: "Full resets",
  quotaSceneNoAccount: "No available account",
  quotaScenePatrolling: "Checking account quotas",
  quotaSceneReady: "Quota supply route",
  queryingQuota: "Querying…",
  refreshQuota: "Refresh quotas",
  quotaLoading: "Querying subscription quotas for saved accounts…",
  quotaNotLoaded: "Subscription quotas have not been queried",
  quotaNotLoadedHint:
    "Automatic refresh is off. Query all saved accounts when needed.",
  loadQuota: "Query quotas",
  queryableAccounts: "Queried",
  queryableAccountsHint: "Saved accounts that returned quota data",
  mostAvailableAccount: "Most available",
  highestWindowUsed: "Highest window {percent}% used",
  nextQuotaRecovery: "Next recovery",
  noneSoon: "None",
  noResetSchedule: "No future reset time was returned",
  earliestCreditExpiry: "Earliest expiry {date}",
  noCreditExpiry: "No full resets available",
  accountQuotaStatus: "Account quota status",
  accountQuotaStatusHint: "Current account first, then lowest peak utilization",
  currentAccount: "Current login",
  savedAccount: "Saved account",
  quotaHealthy: "Healthy",
  quotaAttention: "Attention",
  quotaTight: "Tight",
  quotaUnavailable: "Unavailable",
  quotaUnknown: "Unknown",
  quotaResetDetail: "Recovers {relative} · {date}",
  quotaWindowRecovers: "{window} recovers",
  resetCreditWillExpire: "Full reset expires",
  quotaQueriedAt: "Queried {date}",
  quotaTimeline: "Recovery timeline",
  quotaTimelineHint: "Upcoming window recoveries and full-reset expiries",
  noQuotaEvents: "No future quota events are available.",
  quotaPrivacy:
    "Subscription quotas are queried directly from a ChatGPT compatibility endpoint. Only windows, reset counts, and times reach the interface; authentication tokens never enter the frontend or logs.",
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
  迁移内容无效或已损坏: "The transfer content is invalid or corrupted",
  迁移内容超过允许大小: "The transfer content exceeds the size limit",
  "此账号的迁移内容超过单个二维码容量，请改用剪贴板":
    "This account's transfer content exceeds one QR code. Use the clipboard instead.",
  二维码图片无效或尺寸过大: "The QR code image is invalid or too large",
  图片中未识别到有效的一次性迁移二维码:
    "No valid one-time Auth transfer QR code was found in the image",
  生成迁移二维码失败: "Could not generate the transfer QR code",
  "一次性迁移内容尚未准备好，请重新打开迁移窗口":
    "The one-time transfer is not ready. Reopen the transfer dialog.",
  "刷新后的凭据与待迁移账号不一致，请重新登录":
    "The refreshed credentials do not match the account being transferred. Log in again.",
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
  "无法从一次性迁移内容中识别 ChatGPT 账号 ID":
    "Could not identify the ChatGPT account ID from the one-time transfer.",
  "一次性迁移的刷新响应缺少 refresh_token，未导入任何内容":
    "The one-time transfer refresh response is missing refresh_token. Nothing was imported.",
  "一次性迁移的刷新响应缺少 access_token，未导入任何内容":
    "The one-time transfer refresh response is missing access_token. Nothing was imported.",
  "刷新后的凭据与一次性迁移账号不一致，未导入任何内容":
    "The refreshed credentials do not match the transferred account. Nothing was imported.",
  "刷新响应中的 id_token 无效，未导入任何内容":
    "The refresh response contains an invalid id_token. Nothing was imported.",
  "刷新响应无法识别 ChatGPT 账号 ID，未导入任何内容":
    "The refresh response does not identify a ChatGPT account. Nothing was imported.",
  "旧版迁移内容缺少 id_token，未导入任何内容":
    "The legacy transfer is missing id_token. Nothing was imported.",
  "旧版迁移内容缺少 refresh_token，未导入任何内容":
    "The legacy transfer is missing refresh_token. Nothing was imported.",
  "旧版迁移内容中的账号身份不一致，未导入任何内容":
    "The legacy transfer contains mismatched account identities. Nothing was imported.",
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
      /^刷新订阅凭据失败（HTTP (.+)），迁移内容可能已被使用或已失效，请在发送端重新生成$/,
      (status) =>
        `Could not redeem the one-time transfer (HTTP ${status}). It may already be used or expired; generate a new transfer on the sending device.`,
    ],
    [
      /^刷新响应缺少 access_token，迁移内容可能已被使用或已失效，请在发送端重新生成$/,
      () =>
        "The one-time transfer refresh response is missing access_token. Generate a new transfer on the sending device.",
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

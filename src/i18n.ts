import { useCallback, useLayoutEffect, useState } from "react";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export type Locale = "zh-CN" | "en";

export type MessageKey = keyof typeof zhCN;
type Messages = Record<MessageKey, string>;

const messages = { "zh-CN": zhCN, en } satisfies Record<Locale, Messages>;

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
  "官方账户响应与本地账号不一致，请重新登录":
    "The official account response does not match the saved account. Log in again.",
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

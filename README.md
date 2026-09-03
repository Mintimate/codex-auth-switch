<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/app-icon-dark.svg">
  <img src="./docs/images/app-icon.svg" width="144" height="144" alt="Codex Auth Switch 应用图标">
</picture>

</div>

<h1 align="center">Codex Auth Switch</h1>

<p align="center"><strong>简体中文</strong> · <a href="./README.en.md">English</a></p>
<p align="center">纯本地的 Codex ChatGPT 多账号切换器</p>

<p align="center">
  <a href="https://github.com/Mintimate/codex-auth-switch/releases/latest">下载</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#开发">开发</a> ·
  <a href="https://github.com/Mintimate/codex-auth-switch/issues">反馈问题</a>
</p>

![Codex Auth Switch 账号页](docs/images/dashboard-light.jpg)

> 截图使用内置预览数据，不包含真实账号、令牌或认证信息。

Codex Auth Switch 用于在一台设备上保存和切换多个 Codex ChatGPT 登录，同时提供本机 Token 用量、订阅额度和环境体检。它不代理 Codex 请求，不收集遥测，也不管理 API Key、订阅账单或工作区席位。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属、赞助或背书关系。Codex、ChatGPT 和 OpenAI 是其各自权利人的商标。

## 主要能力

- 保存、重命名和一键切换本机账号；切换前会捕获可能已轮换的令牌
- 通过浏览器 Device Code 授权添加账号，无需在应用中输入密码
- 汇总今天、近 7 天和近 30 天的本机会话 Token，并按账号与模型提供方拆分
- 展示订阅额度窗口、恢复时间轴、近 7 天 Token 和一年活跃热力图
- 通过二维码或剪贴板完成一次性 Auth 迁移，并继续兼容旧版 CAS2 导入
- 提供只读环境体检、亮色/暗色主题、中英文界面和签名更新

## 界面预览

| Token 用量                                                   | 订阅额度                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| ![Codex Auth Switch Token 用量](docs/images/usage-light.jpg) | ![Codex Auth Switch 订阅额度](docs/images/quota-light.jpg) |

## 下载与安装

前往 [Releases](https://github.com/Mintimate/codex-auth-switch/releases/latest) 下载对应安装包。

| 系统    | 架构                  | 格式                          |
| ------- | --------------------- | ----------------------------- |
| macOS   | Apple Silicon / Intel | `.dmg`                        |
| Windows | x64                   | `.exe` / `.msi`               |
| Linux   | x64                   | `.AppImage` / `.deb` / `.rpm` |

macOS 安装包使用 ad-hoc 签名。首次打开时，可能需要在“系统设置 → 隐私与安全性”中确认。请只从本项目 Releases 下载。

## 快速开始

### 1. 启用文件凭据存储

在 `CODEX_HOME/config.toml`（默认为 `~/.codex/config.toml`）中设置：

```toml
cli_auth_credentials_store = "file"
```

应用不会修改 `keyring` 或 `auto`，API Key 登录也不会被保存为订阅账号。

### 2. 保存或添加账号

打开应用后，可以保存当前 Codex ChatGPT 登录，也可以选择“登录新账号”，在浏览器中完成 Device Code 授权。

### 3. 切换账号

在账号库中选择“切换到此账号”。应用会校验目标账号，并原子替换 Codex 当前使用的 `auth.json`。

### 4. 跨设备迁移（可选）

一次性 Auth 迁移支持二维码与剪贴板。发送前应停止发送端的 Codex 会话；接收端导入后会立即刷新并校验账号。需要两端长期使用时，请在接收设备重新发起 OAuth 授权。

## 安全边界

```text
CODEX_HOME/auth.json
        ↕ 本机读取 / 原子替换
Codex Auth Switch (Tauri + Rust)
        ↕ 本机账号库
accounts.v1.json
```

- 账号快照、Token 聚合和诊断都留在本机；没有自建后端、遥测或分析服务
- 认证数据的读取、校验、迁移和写入由 Rust 后端完成，原始令牌不会进入前端或日志
- macOS/Linux 上的应用数据目录使用 `0700`，账号库和临时认证文件使用 `0600`
- API Key 认证与 ChatGPT 订阅认证保持分离
- 用量页只读取会话中的 `token_count` 和 `session_meta.model_provider`，不保留提示词或回复正文
- 订阅数据优先读取本机 Codex App Server；直接 HTTP 降级仅是隔离的兼容实现，不应视为稳定公开 API

> [!WARNING]
> OAuth 配对码和一次性 Auth 迁移内容都可能授予账号访问能力。只提供给预期的账号持有人；迁移成功后不要继续在发送端使用同一账号。

## 当前限制

- 仅支持 `cli_auth_credentials_store = "file"`
- Device Code 登录仍为 Beta，可能需要用户或工作区管理员先启用
- 官方 App Server 不提供订阅到期日；本机 Token 统计也不等同于官方订阅总额度
- 历史会话没有可靠账号 ID，账号归属从应用开始记录切换时间线后生效

## 开发

需要 Node.js 20+、Rust stable、npm 和 Tauri 2 对应的平台构建依赖。

```bash
npm install
npm run dev
```

提交前检查：

```bash
npm run format
npm run typecheck
npm run build:web

cd src-tauri
cargo fmt --all
cargo test
```

发布版本必须使用 `npm run release <version>` 同步版本、创建提交与标签；推送 `v*` 标签后由 CI 构建、签名并发布各平台安装包。

## License

[MIT](LICENSE)

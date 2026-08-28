<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/app-icon-dark.svg">
  <img src="./docs/images/app-icon.svg" width="156" height="156" alt="Codex Auth Switch 应用图标">
</picture>

</div>

<h1 align="center">Codex Auth Switch</h1>

<p align="center"><strong>简体中文</strong> | <a href="./README.en.md">English</a></p>

<p align="center">纯本地 · 切换 Auth</p>

<p align="center">
  <a href="https://github.com/Mintimate/codex-auth-switch/releases/latest">最新版本下载</a> |
  <a href="#快速开始">快速使用指南</a> |
  <a href="#核心功能">功能一览</a> |
  <a href="#安全模型">数据安全</a> |
  <a href="https://github.com/Mintimate/codex-auth-switch/releases">版本更新记录</a> |
  <a href="#开发">研发手册</a> |
  <a href="https://github.com/Mintimate/codex-auth-switch/issues">反馈问题</a>
</p>

![Codex Auth Switch 亮色仪表盘](docs/images/dashboard-light.jpg)

> 截图使用内置预览数据，不包含真实账号或认证信息。

Codex Auth Switch 解决的不是 OpenAI 订阅、账单或 API Key 管理，而是本机多个 Codex ChatGPT 登录之间的切换问题。它不代理 Codex 请求、不收集遥测，也不会将认证数据发送到项目自建服务。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属、赞助或背书关系。Codex、ChatGPT 和 OpenAI 是其各自权利人的商标。

## 界面预览

| 暗色主题                                                        | Auth 分享（不推荐）                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| ![Codex Auth Switch 暗色仪表盘](docs/images/dashboard-dark.jpg) | ![Codex Auth Switch Auth 分享弹窗](docs/images/auth-share-dialog.jpg) |

## 下载与安装

前往 [Releases](https://github.com/Mintimate/codex-auth-switch/releases/latest) 下载与系统匹配的安装包。

| 系统    | 架构                  | 格式                          |
| ------- | --------------------- | ----------------------------- |
| macOS   | Apple Silicon / Intel | `.dmg`                        |
| Windows | x64                   | `.exe` / `.msi`               |
| Linux   | x64                   | `.AppImage` / `.deb` / `.rpm` |

macOS 安装包使用 ad-hoc 签名，首次打开时可能需要在“系统设置 → 隐私与安全性”中确认。部分系统也可能对未使用商业证书签名的开源安装包显示风险提示，请确认下载来自本项目的 GitHub Releases。

## 快速开始

### 1. 启用文件凭据存储

当前版本只管理 Codex 的文件凭据。在 `CODEX_HOME/config.toml`（默认为 `~/.codex/config.toml`）中设置：

```toml
cli_auth_credentials_store = "file"
```

`keyring` 和 `auto` 模式不会被修改，应用会显示明确提示。API Key 登录与 ChatGPT 订阅登录也保持分离，不会被当作可切换的订阅账号。

### 2. 保存当前登录

打开应用，为当前 Codex ChatGPT 登录设置一个本地名称，然后选择“保存当前登录”。

### 3. 通过 OAuth 添加账号

选择“OAuth 添加账号”后，应用会显示浏览器地址和一次性配对验证码。你可以在本机浏览器完成授权，也可以把这两项提供给账号持有人；授权成功后，发起配对的设备会自动保存并切换到该账号。

原有的 Auth 二维码和剪贴板分享仍然保留，用于兼容已有迁移流程，但不推荐跨设备使用。复用登录凭据可能导致 401；接收设备应优先发起 OAuth 配对。

### 4. 一键切换

在“已保存账号”中选择“切换到此账号”。应用会先保存当前账号可能已轮换的令牌，再原子替换 Codex 正在使用的认证文件。

## 核心功能

### 账号管理

- 检测当前 Codex ChatGPT 登录
- 保存、重命名和一键切换本机账号
- 通过浏览器 Device Code 授权添加账号
- 移除任意账号的本地保存副本；移除当前账号不会注销或中断当前 Codex 登录
- 切换前自动捕获当前账号可能轮换过的令牌

### 用量观察

- 汇总今天、近 7 天和近 30 天的本机 Token 用量
- 展示 14 天趋势、输入/输出 Token 构成和账号归属
- 按账号查看订阅用量窗口，单个账号查询失败时独立降级
- 只读取会话中的 `token_count` 元数据，不解析提示词或回复正文

### OAuth 配对

- 在接收账号的设备发起 Device Code OAuth，展示浏览器地址和短期配对码
- 账号持有人可在其他浏览器中完成授权，无需传递已有 Auth 或 refresh token
- 授权成功后，仅将认证服务返回的登录数据写入发起配对设备的本地 Codex 缓存

### Auth 分享（不推荐）

- 仍可通过系统剪贴板或二维码在设备间迁移 Auth
- 分享数据的编解码、剪贴板访问和二维码处理都在 Rust 后端中完成
- 前端不会获得可复制的原始令牌文本
- 跨设备复用登录凭据可能导致 401，应优先使用 OAuth 配对

### 桌面体验

- 简体中文和英文界面，语言选择会在本机持久保存
- 账号、Token 用量与设置采用独立 Tab，支持设置默认启动页
- 可选择进入 Token 用量页时是否自动刷新本机统计与订阅窗口
- 亮色、暗色与跟随系统三种外观模式
- macOS、Windows 和 Linux 桌面安装包
- 本机账号库路径可见，可直接在文件管理器中定位
- 可在设置页选择 GitHub 或 CNB，检查并安装对应 Release 发布的签名更新

## 数据边界

```text
CODEX_HOME/auth.json
        ↕ 本机读取 / 原子替换
Codex Auth Switch (Tauri + Rust)
        ↕ 本机账号库
accounts.v1.json
```

- 应用不代理 Codex 会话请求，也没有自建后端、遥测或分析服务。
- Device Code 登录时直接与 OpenAI 认证服务通信，仅请求写入本地 Codex 缓存所需的认证数据。
- 订阅用量查询直接访问 ChatGPT 兼容性接口。该端点和字段并非 OpenAI 承诺稳定的公开 API，变化时可能影响额度显示，但不影响账号切换和本机 Token 统计。
- 用量页面中的 Token 数字是本机会话元数据的汇总，不是 ChatGPT 官方订阅总额度。
- Codex 历史会话没有可靠的账号 ID，因此账号归属从应用记录切换时间线后开始生效，更早的数据会显示为“历史未归属”。

## 安全模型

Codex 文件凭据模式将登录缓存保存在 `CODEX_HOME/auth.json`，默认路径为 `~/.codex/auth.json`。该文件包含访问令牌，应当像密码一样保护。

Codex Auth Switch 会在自己的应用数据目录保存账号快照：

- macOS/Linux 上的应用数据目录权限设置为 `0700`
- 账号库和临时认证文件权限设置为 `0600`
- 日常状态接口只向前端返回脱敏账号摘要
- 本机 Token 解析完全在 Rust 后端完成，前端只接收聚合数字
- 日志和错误消息不会包含令牌
- macOS/Linux 上的凭据切换使用同目录原子替换

如果设备已被其他高权限用户控制，本地文件权限无法提供额外保护。系统钥匙串模式目前不在支持范围内。

> [!WARNING]
> OAuth 配对码在有效期内可授权发起配对的设备，只应提供给预期的账号持有人。Auth 分享载荷则包含长期可登录凭据，不推荐跨设备使用；请勿把二维码截图或剪贴板内容发送给不受信任的人。

## 当前限制

- 仅支持 `cli_auth_credentials_store = "file"`
- Device Code 登录仍是 Beta，可能需要个人用户或工作区管理员先启用相应权限
- 订阅用量窗口来自兼容性实现，不是官方承诺的稳定对外 API
- 本机 Token 数据取决于 Codex 会话文件中可用的 `token_count` 元数据
- 项目不管理 OpenAI API Key、订阅计费或工作区席位

## 开发

需要：

- Node.js 20+
- Rust stable
- npm
- Tauri 2 的平台构建依赖

```bash
npm install
npm run dev
```

前端校验：

```bash
npm run format
npm run typecheck
npm run build:web
```

Rust 校验：

```bash
cd src-tauri
cargo fmt --all
cargo test
```

发布流水线需要配置 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`；如果私钥设置了密码，同时配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。更新签名公钥已固化在 `src-tauri/tauri.conf.json`，后续发布必须保留对应私钥，否则已安装版本无法验证新更新。

## 发布新版本

版本号分布在 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 三处，必须完全一致。请使用脚本同步，不要手工逐个修改：

```bash
npm run bump 0.7.3      # 只更新版本号文件
npm run release 0.7.3   # 更新版本号，并创建提交与标签
```

脚本会同步 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`，随后回读校验三处版本号一致。`Cargo.lock` 中可能存在与本项目版本号相同的第三方依赖，脚本只修改 `codex-auth-switch` 所属的包块。

确认无误后推送标签触发发布：

```bash
git push origin main --follow-tags
```

流水线以 `src-tauri/tauri.conf.json` 的版本为准，并校验 Git 标签与之一致；不一致会直接失败。标签推送后，GitHub Actions 会构建四个平台安装包、生成版本说明、校验更新清单与签名，并将草稿转为正式发布。GitHub Release 成功后，对应标签才会同步到 CNB；CNB 的 `tag_push` 流水线随后直接从 GitHub 拉取更新清单与附件，使用同一版本说明生成逻辑，改写 CNB 更新地址并创建镜像 Release。

需要手写版本说明时，在打标签前添加 `docs/release-notes/vX.Y.Z.md`；否则版本说明会依据 Conventional Commits 自动生成。

## 项目结构

```text
src/                        React 桌面界面
src-tauri/src/manager.rs    账号库、认证校验与切换核心
src-tauri/src/usage.rs      本机会话 Token 聚合
src-tauri/src/auth_share.rs Auth 分享编码与二维码处理
src-tauri/src/lib.rs        Tauri 命令边界
src-tauri/icons/            应用图标；Assets.xcassets 由 CI 编译为 macOS 明暗图标
scripts/bump-version.mjs    版本号同步脚本
.cnb.yml                    CNB 从 GitHub 拉取并镜像 Release 的流水线
.cnb/scripts/               GitHub Release 拉取与 CNB 发布脚本
docs/images/                README 预览截图与应用图标
docs/release-notes/         手写版本说明（可选）
```

## 官方参考

- [OpenAI 认证文档](https://learn.chatgpt.com/docs/auth)
- [OpenAI Codex 方案与用量说明](https://learn.chatgpt.com/docs/pricing)

OpenAI 官方文档将 Device Code 登录标记为 Beta，并说明可能需要用户或工作区管理员先在 ChatGPT 安全设置中启用。官方用量说明也指出，用量取决于模型、上下文和任务复杂度，本地与云端任务会共享相应的用量窗口。本 README 确认的是这些产品能力；应用使用的具体 HTTP 端点和字段属于兼容性实现，不应视为 OpenAI 对公开 API 稳定性的承诺。

## License

[MIT](LICENSE)

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
  <a href="#codex-配置">Codex 配置</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#开发">开发</a> ·
  <a href="https://github.com/Mintimate/codex-auth-switch/issues">反馈问题</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/dashboard-dark.jpg">
  <img src="./docs/images/dashboard-light.jpg" alt="Codex Auth Switch 1.1.1：当前登录、切换流程与本机账号库">
</picture>

> 截图基于 1.1.1 的内置预览数据，不包含真实账号、令牌或认证信息。

Codex Auth Switch 用于在一台设备上保存和切换多个 Codex ChatGPT 登录，同时提供 Codex 配置编辑、本机 Token 用量、订阅额度和环境体检。它不代理 Codex 请求，不收集遥测，也不管理 API Key、订阅账单或工作区席位。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属、赞助或背书关系。Codex、ChatGPT 和 OpenAI 是其各自权利人的商标。

## 主要能力

- 保存、重命名和一键切换本机账号；切换前会捕获可能已轮换的令牌
- 通过浏览器 Device Code 授权添加账号，无需在应用中输入密码
- 在配置中心调整凭据存储、1M 上下文预设、推理强度、推理摘要、回答详细度和联网搜索
- 汇总今天、近 7 天和近 30 天的本机会话 Token，并按账号与模型提供方拆分
- 展示订阅额度窗口、恢复时间轴、近 7 天 Token 和一年活跃热力图
- 进入用量或额度页时按需刷新对应数据；可关闭自动刷新，改为手动读取
- 通过二维码或剪贴板完成一次性 Auth 迁移，并继续兼容旧版 CAS2 导入
- 提供只读环境体检、隐藏邮箱的私密模式、亮色/暗色主题、中英文界面和 GitHub/CNB 签名更新

## 界面预览

| Codex 配置                                                                               | Token 用量                                                                       |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| ![Codex 配置中心：凭据存储、1M 上下文、模型输出与联网搜索](docs/images/config-light.jpg) | ![Token 用量：本机汇总、每日趋势与账号及提供方归属](docs/images/usage-light.jpg) |

| 订阅额度                                                                   | 应用设置                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ![订阅额度：多额度窗口、恢复时间轴与账号用量](docs/images/quota-light.jpg) | ![应用设置：语言、私密模式、主题与自动刷新](docs/images/settings-light.jpg) |

<details>
<summary>环境体检与一次性 Auth 迁移</summary>

| 环境体检                                                     | 一次性 Auth 迁移                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| ![只读环境体检与应用更新](docs/images/diagnostics-light.jpg) | ![一次性 Auth 迁移对话框，二维码为无认证信息的预览图案](docs/images/auth-share-dialog.jpg) |

</details>

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

打开侧边栏“Codex 配置”，将“登录凭据存储”选为“文件”；也可以在账号页按提示选择“启用登录信息文件管理”。对应的 `CODEX_HOME/config.toml`（默认为 `~/.codex/config.toml`）配置为：

```toml
cli_auth_credentials_store = "file"
```

应用不会自动更改已有的存储方式。选择 `auto` 或 `keyring` 时，账号管理功能不可用；API Key 登录不会被保存为订阅账号。

### 2. 保存或添加账号

打开应用后，可以保存当前 Codex ChatGPT 登录，也可以选择“登录新账号”，设置本机名称后在浏览器中完成 Device Code 授权。授权成功后，应用会自动保存并切换到新账号。

### 3. 切换账号

在账号库中选择“切换到此账号”。应用会校验目标账号，并原子替换 Codex 当前使用的 `auth.json`。

### 4. 跨设备迁移（可选）

一次性 Auth 迁移支持二维码与剪贴板。发送前应停止发送端的 Codex 会话；接收端导入后会立即刷新并校验账号。需要两端长期使用时，请在接收设备重新发起 OAuth 授权。

## Codex 配置

侧边栏的“Codex 配置”直接编辑本机 `config.toml`。每次选择只更新对应的受支持字段，保留其他配置与注释，并在界面中回显配置值。

| 配置         | 可选项                                             |
| ------------ | -------------------------------------------------- |
| 登录凭据存储 | 默认、文件、自动、系统钥匙串；账号切换需要文件模式 |
| 上下文窗口   | 跟随默认，或 1M 上下文与 900K 自动压缩阈值         |
| 推理强度     | 默认、最小、低、中、高、超高                       |
| 推理摘要     | 默认、自动、简洁、详细、关闭                       |
| 回答详细度   | 默认、低、中、高                                   |
| 联网搜索     | 默认、关闭、缓存、索引、实时                       |

选择“默认”会移除对应字段，由 Codex 决定默认值。已有的非预设值会显示为“自定义”；切换预设前不会覆盖它们。1M 等设置只是本地配置预设，实际支持情况取决于所用 Codex 版本、模型和服务。

## 用量与额度

“Token 用量”汇总本机会话元数据；“订阅额度”查询账号的在线额度。两页分别加载，打开账号页不会自动查询订阅额度。在“设置 → 用量与额度”中可关闭“进入页面时自动刷新”，之后通过页面按钮手动读取或查询。

额度页会根据可用数据展示套餐、多个额度窗口、完整重置次数与有效期，以及账号用量和活跃热力图；并非所有账号或数据来源都返回完整信息。遇到网络错误可手动重试；限流提示出现后请稍后再试。

支持刷新全部账号，也可在账号卡片上单独刷新。不同账号共享最多 2 个并发名额，同账号查询串行执行。批量查询会逐个显示已完成的结果；刷新失败时保留上次成功结果，并显示错误和原查询时间。

本地用量支持 `file`、`auto` 和 `keyring` 凭据模式，无需迁移凭据。扫描在应用数据目录保存可重建的 `usage-cache.v2.json.gz`：未变更文件复用统计，追加文件只解析新增完整行，截断或替换的文件重新扫描。缓存仅保存文件校验信息、提供方标识、事件时间和 Token 计数，不保存会话正文或认证数据。账号归属仍依赖本机已记录的切换历史。缓存压缩后最多 8 MiB，只保留近 35 天统计；容量不足时淘汰较旧文件的缓存，不影响当前完整统计。启动或访问缓存时自动清理超过 7 天未更新的缓存及旧版缓存。可在“设置 → 用量与额度”查看占用并手动清理；清理不删除账号、认证数据或 Codex 会话文件，下次刷新按需重建。

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

- 账号保存、切换与订阅额度查询仅支持 `cli_auth_credentials_store = "file"`；本地 Token 用量不受此限制
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

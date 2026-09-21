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
  <a href="#订阅价值模拟">价值模拟</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#开发">开发</a> ·
  <a href="https://github.com/Mintimate/codex-auth-switch/issues">反馈问题</a>
</p>

<a href="./docs/images/dashboard-light.jpg">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/images/dashboard-dark.jpg">
    <img src="./docs/images/dashboard-light.jpg" alt="Codex Auth Switch：当前账号、登录入口与切换流程">
  </picture>
</a>

> 中英文 README 共用中文界面截图，均来自应用的内置演示数据，不包含真实账号、令牌或认证信息。
> 静态截图按 2 倍清晰度渲染，原图宽 2880 像素；GIF 保留原尺寸。点击图片可查看原图。

Codex Auth Switch 用于在一台设备上保存和切换多个 Codex ChatGPT 登录，同时提供 Codex 配置编辑、本机 Token 用量、订阅额度、订阅价值模拟和环境体检。它不代理 Codex 请求，不收集遥测，也不管理 API Key、订阅账单或工作区席位。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属、赞助或背书关系。Codex、ChatGPT 和 OpenAI 是其各自权利人的商标。

## 主要能力

侧栏按六个页面组织操作与数据：

| 页面         | 用途                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| 账号         | 保存、重命名和切换本机账号；浏览器 Device Code 登录；二维码或剪贴板一次性 Auth 迁移 |
| Codex 配置   | 编辑凭据存储、上下文窗口、推理、回答详细度和联网搜索设置                            |
| Token 用量   | 查看本机会话的 Token 汇总、每日趋势，以及账号和模型提供方归属                       |
| 订阅额度     | 搜索、筛选与比较账号额度，查看恢复时间、重置次数和每日活跃热力图                    |
| 订阅价值模拟 | 独立估算近 7 / 30 天账号用量的 API 参考价值，调整模型与比例，查看费用拆分           |
| 设置         | 选择语言、主题、私密模式和默认启动页，管理自动刷新、环境体检及签名更新              |

界面统一文字层级，并支持窄窗口中的换行、降列和表格横向滚动。“订阅价值模拟”进入后直接显示控件，可设为默认启动页，也能分别刷新账号用量和价格。

## 界面预览

**订阅价值模拟：场景预设、输入与缓存比例、费用拆分**

[![独立订阅价值模拟页：场景预设、输入与缓存比例、费用拆分](docs/images/value-light.jpg)](docs/images/value-light.jpg)

<details>
<summary>查看暗色价值模拟</summary>

[![暗色主题下的订阅价值模拟](docs/images/value-dark.jpg)](docs/images/value-dark.jpg)

</details>

| Codex 配置                                                                                        | Token 用量                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [![Codex 配置：凭据存储与上下文窗口](docs/images/config-light.jpg)](docs/images/config-light.jpg) | [![Token 用量：本机会话汇总、趋势与归属](docs/images/usage-light.jpg)](docs/images/usage-light.jpg) |

| 订阅额度                                                                                                | 设置                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [![订阅额度：账号比较、搜索筛选与活跃热力图](docs/images/quota-light.jpg)](docs/images/quota-light.jpg) | [![应用设置：语言、隐私、外观、默认页面与代理](docs/images/settings-light.jpg)](docs/images/settings-light.jpg) |

| 环境体检                                                                                          | 一次性 Auth 迁移                                                                                               |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [![只读环境体检与检查结果](docs/images/diagnostics-light.jpg)](docs/images/diagnostics-light.jpg) | [![Auth 迁移动图：准备与演示二维码状态](docs/images/auth-share-dialog.gif)](docs/images/auth-share-dialog.gif) |

Auth 迁移动图使用内置演示图案，不含可用凭据。

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

打开应用后，可以保存当前 Codex ChatGPT 登录，也可以选择“登录新账号”，设置本机名称后在浏览器中完成 Device Code 授权。授权成功后，应用会自动保存并切换到新账号；请重启 Codex 后使新账号生效。

### 3. 切换账号

在账号库中点击带有双向箭头图标的“切换”按钮，可选择“仅切换”或“切换并重启”，并记住选择。在“设置 → 已保存账号切换方式”中可修改默认行为；默认每次询问，不自动退出客户端。

“切换并重启”会先校验目标账号和客户端，再请求 Codex 桌面客户端正常退出，等待退出后保存旧账号最新凭据、原子替换 `auth.json`，最后重新打开原客户端。重启可能中断任务，请先结束正在执行的任务。退出超时不会强杀进程或写入新账号；若账号已切换但启动失败，会单独提示手动打开。客户端未运行时只切换，不自动启动。

自动重启兼容层支持 macOS（应用标识 `com.openai.codex`）和 Windows（可识别为 OpenAI Codex 的桌面映像）；不会结束独立 CLI、VS Code 或其它 IDE。Linux、自定义 `CODEX_HOME`、多个桌面实例及无法确认身份的客户端请使用“仅切换”，并手动重启对应会话。新账号登录和 Auth 导入不受此设置影响，仍需手动重启。此能力是本工具的本地兼容实现，不是官方保证的账号切换接口。

### 4. 跨设备迁移（可选）

一次性 Auth 迁移支持二维码与剪贴板。发送前应停止发送端的 Codex 会话；接收端导入后会立即刷新并校验账号，写入完成后请重启 Codex 使切换生效。需要两端长期使用时，请在接收设备重新发起 OAuth 授权。

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

| 页面         | 数据来源                                     | 统计含义                                              |
| ------------ | -------------------------------------------- | ----------------------------------------------------- |
| Token 用量   | 本机 Codex 会话元数据                        | 今天、近 7 天与近 30 天的本机使用情况，不代表账号全量 |
| 订阅额度     | 账号在线额度与每日 Token 总数                | 可用额度、恢复时间与账号用量；部分字段可能缺失        |
| 订阅价值模拟 | 复用订阅额度的账号每日总量，加上参考模型价格 | 基于假设的 API 费用换算，不是订阅或 API 账单          |

三个页面均可按需刷新，打开账号页不会自动查询额度。在“设置 → 用量与额度”中关闭“进入页面时自动刷新”后，可通过页面按钮手动读取。价值模拟页可以直接刷新账号用量，无需先进入额度页。

账号数据支持全部或逐个刷新，不同账号最多 2 个并发，同一账号串行查询。失败时保留上次成功结果及原查询时间；首次失败会提示重试，缺失数据不会当成零。并非所有账号都返回完整额度字段；遇到限流请稍后重试。

<details>
<summary>本地用量缓存与清理</summary>

本地用量支持 `file`、`auto` 和 `keyring` 凭据模式。可重建的 `usage-cache.v2.json.gz` 复用未变更文件的统计，增量读取新增完整行，并重新扫描截断或替换的文件。缓存只保存文件校验信息、提供方、时间与 Token 计数，不保存会话正文或认证数据；账号归属依赖本机切换历史。

缓存压缩后最多 8 MiB，保留 35 天统计；必要时淘汰旧缓存，不影响当前完整统计。启动或访问缓存时清理超过 7 天未更新的缓存及旧版缓存。可在“设置 → 用量与额度”查看或清理占用；清理不删除账号、凭据或会话文件，下次刷新会按需重建。

</details>

## 订阅价值模拟

选择全部账号或单个账号，按含今天的近 7 / 30 个 UTC 自然日汇总每日 Token 总数。同一订阅的多个本地档案只统计一次。此功能不读取本机会话，也无法从账号总量得知实际模型、输入／输出或缓存拆分。

| 试算预设         | 输入占比 | 输入缓存比例 |
| ---------------- | -------- | ------------ |
| 编程多轮（默认） | 99%      | 90%          |
| 通用多轮         | 90%      | 50%          |
| 新任务／少复用   | 80%      | 0%           |

预设只是试算起点，**不是平均值、账号实测或真实账单**。输入与缓存比例均支持滑块、数字输入和 0.1% 步长。缓存比例以输入 Token 为分母，输出不享受缓存折扣；页面对比零缓存，并拆分普通输入、缓存输入和输出费用。只有假设缓存量大于零时，缺少缓存单价才影响该场景计算。

连续复用上下文有利于缓存命中，压缩、切换模型或较长间隔可能降低命中率。[官方多轮 Agent 缓存示例](https://developers.openai.com/api/docs/guides/prompt-caching#multi-turn-agent) 中的超过 90% 是特定部署结果，不能当作所有任务的平均水平。

价格来自 [OpenAI 公开价格](https://developers.openai.com/api/docs/pricing)，默认使用内置或本机缓存；“拉取最新价格”仅下载公开文档，不携带认证凭据或用量，失败保留旧价格和日期。模拟采用 Standard 短上下文文本单价，未计长上下文加价、Fast、缓存写入、工具调用、税费和折扣。价格解析与认证、额度兼容层独立，文档变化时不会猜测价格。

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

- 账号保存、切换、订阅额度查询及价值模拟的账号用量查询仅支持 `cli_auth_credentials_store = "file"`；本地 Token 用量不受此限制
- Device Code 登录仍为 Beta，可能需要用户或工作区管理员先启用
- 官方 App Server 不提供订阅到期日；本机 Token 统计也不等同于官方订阅总额度
- 历史会话没有可靠账号 ID，账号归属从应用开始记录切换时间线后生效

## 开发

需要 Node.js 20+、Rust stable、npm 和 Tauri 2 对应的平台构建依赖。

```bash
npm install
npm run dev
```

仅预览界面可运行 `npm run dev:web`，打开终端给出的浏览器地址。浏览器开发模式使用内置演示数据，可查看各页面和主题；真实账号操作需在 Tauri 应用中验证。界面修改请遵循[字体规范](docs/typography.md)，并检查中英文、明暗主题及窄窗口布局。

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

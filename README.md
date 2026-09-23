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
  <a href="https://codex-auth-switch.mintimate.cn"><strong>在线预览</strong></a> ·
  <a href="https://github.com/Mintimate/codex-auth-switch/releases/latest"><strong>下载桌面版</strong></a> ·
  <a href="https://github.com/Mintimate/codex-auth-switch/issues">反馈问题</a>
</p>

<p align="center">
  <a href="#主要能力">主要能力</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#codex-配置">Codex 配置</a> ·
  <a href="#订阅价值模拟">价值模拟</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#开发">开发</a>
</p>

[在线体验](https://codex-auth-switch.mintimate.cn)：无需安装即可浏览各页面、切换主题和模拟费用；账号与用量均为虚构数据，真实登录及账号操作需使用桌面版。

<table>
  <tr>
    <th width="50%">账号与切换</th>
    <th width="50%">订阅价值模拟</th>
  </tr>
  <tr>
    <td align="center" valign="top">
      <a href="./docs/images/dashboard-light.jpg">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="./docs/images/dashboard-dark.jpg">
          <img src="./docs/images/dashboard-light.jpg" width="100%" alt="当前账号、登录入口与切换流程">
        </picture>
      </a>
      <a href="./docs/images/dashboard-light.jpg">亮色原图</a> · <a href="./docs/images/dashboard-dark.jpg">暗色原图</a>
    </td>
    <td align="center" valign="top">
      <a href="./docs/images/value-light.jpg">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="./docs/images/value-dark.jpg">
          <img src="./docs/images/value-light.jpg" width="100%" alt="订阅价值模拟：场景预设、输入与缓存比例、费用拆分">
        </picture>
      </a>
      <a href="./docs/images/value-light.jpg">亮色原图</a> · <a href="./docs/images/value-dark.jpg">暗色原图</a>
    </td>
  </tr>
</table>

> 截图和动图均使用内置演示数据，不包含真实账号或可用凭据。点击图片可查看原图。

Codex Auth Switch 用于在一台设备上保存和切换多个 Codex ChatGPT 登录，同时提供 Codex 配置编辑、本机 Token 用量、订阅额度、订阅价值模拟和环境体检。它不代理 Codex 请求，不收集遥测，也不管理 API Key、订阅账单或工作区席位。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属、赞助或背书关系。Codex、ChatGPT 和 OpenAI 是其各自权利人的商标。

## 主要能力

侧栏按六个页面组织操作与数据：

| 页面         | 用途                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| 账号         | 保存、重命名和切换本机账号；本机 Codex 浏览器登录、Device Code 登录；二维码或剪贴板一次性 Auth 迁移 |
| Codex 配置   | 编辑凭据存储、上下文窗口、推理、回答详细度和联网搜索设置                            |
| Token 用量   | 查看本机会话的 Token 汇总、每日趋势，以及账号和模型提供方归属                       |
| 订阅额度     | 搜索、筛选与比较账号额度，查看恢复时间、重置次数和每日活跃热力图                    |
| 订阅价值模拟 | 独立估算近 7 / 30 天账号用量的 API 参考价值，调整模型与比例，查看费用拆分           |
| 设置         | 选择语言、主题、私密模式和默认启动页，管理自动刷新、环境体检及签名更新              |

界面统一文字层级，并支持窄窗口中的换行、降列和表格横向滚动。“订阅价值模拟”进入后直接显示控件，可设为默认启动页，也能分别刷新账号用量和价格。

## 界面预览

可直接[在线体验](https://codex-auth-switch.mintimate.cn)，也可以按功能展开截图：

<details>
<summary><strong>用量与额度</strong> · Token 趋势、账号额度与活跃热力图</summary>

<table>
  <tr>
    <th width="50%">Token 用量</th>
    <th width="50%">订阅额度</th>
  </tr>
  <tr>
    <td valign="top"><a href="./docs/images/usage-light.jpg"><img src="./docs/images/usage-light.jpg" width="100%" alt="Token 用量：本机会话汇总、趋势与归属"></a></td>
    <td valign="top"><a href="./docs/images/quota-light.jpg"><img src="./docs/images/quota-light.jpg" width="100%" alt="订阅额度：账号比较、搜索筛选与活跃热力图"></a></td>
  </tr>
</table>

</details>

<details>
<summary><strong>配置与设置</strong> · Codex 参数、外观与应用偏好</summary>

<table>
  <tr>
    <th width="50%">Codex 配置</th>
    <th width="50%">设置</th>
  </tr>
  <tr>
    <td valign="top"><a href="./docs/images/config-light.jpg"><img src="./docs/images/config-light.jpg" width="100%" alt="Codex 配置：凭据存储与上下文窗口"></a></td>
    <td valign="top"><a href="./docs/images/settings-light.jpg"><img src="./docs/images/settings-light.jpg" width="100%" alt="应用设置：语言、隐私、外观、默认页面与代理"></a></td>
  </tr>
</table>

</details>

<details>
<summary><strong>环境体检与 Auth 迁移</strong> · 检查结果与迁移动图</summary>

<table>
  <tr>
    <th width="50%">环境体检</th>
    <th width="50%">一次性 Auth 迁移</th>
  </tr>
  <tr>
    <td valign="top"><a href="./docs/images/diagnostics-light.jpg"><img src="./docs/images/diagnostics-light.jpg" width="100%" alt="只读环境体检与检查结果"></a></td>
    <td valign="top"><a href="./docs/images/auth-share-dialog.gif"><img src="./docs/images/auth-share-dialog.gif" width="100%" alt="Auth 迁移动图：准备与演示二维码状态"></a></td>
  </tr>
</table>

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

应用不会自动更改已有的存储方式。选择 `auto` 或 `keyring` 时，当前账号保存、切换和额度查询不可用；新增的本机 Codex 登录仍可保存账号，切换时再明确启用文件模式；API Key 登录不会被保存为订阅账号。

### 2. 保存或添加账号

打开应用后，可以保存当前 Codex ChatGPT 登录，也可以选择“登录新账号”，设置本机名称并选择登录方式：

- **本地 Codex 登录（实验性）**：先在侧边栏“实验室”中启用，再回到“登录新账号”选择。此功能默认关闭。调用已安装的 Codex CLI 或桌面客户端内置运行时，在浏览器完成授权。成功后只保存到本地账号库；点击“切换到此账号”或稍后从列表切换。同一账号重新登录会更新其记录，并显示“新登录待切换”。
- **OAuth 登录（设备码）**：沿用现有 Device OAuth 流程，输入配对码并授权，成功后保存并切换；重启 Codex 后使新账号生效。

本机 Codex 登录在独立临时目录中进行，不改动当前认证或存储配置；授权链接仅可在这台电脑上完成回调。没有可用运行时、版本不支持或回调端口被占用时，可结束此次登录并使用设备码方式。取消、超时和正常退出会终止此次进程并清理临时目录；启动时清理超过一天的残留目录。

### 3. 切换账号

在账号库中点击带有双向箭头图标的“切换”按钮，可选择“仅切换”或“切换并重启”，并记住选择。在“设置 → 已保存账号切换方式”中可修改默认行为；默认每次询问，不自动退出客户端。

“切换并重启”会先校验目标账号和客户端，再请求 Codex 桌面客户端正常退出，等待退出后保存旧账号最新凭据、原子替换 `auth.json`，最后重新打开原客户端。重启可能中断任务，请先结束正在执行的任务。退出超时不会强杀进程或写入新账号；若账号已切换但启动失败，会单独提示手动打开。客户端未运行时只切换，不自动启动。

自动重启兼容层支持 macOS（应用标识 `com.openai.codex`）和 Windows（可识别为 OpenAI Codex 的桌面映像）；不会结束独立 CLI、VS Code 或其它 IDE。Linux、自定义 `CODEX_HOME`、多个桌面实例及无法确认身份的客户端请使用“仅切换”，并手动重启对应会话。设备码登录和 Auth 导入不受此设置影响，仍需手动重启；本机 Codex 登录后的主动切换沿用此设置。此能力是本工具的本地兼容实现，不是官方保证的账号切换接口。

切换已保存账号后，账号页显示本次操作结果、认证文件是否匹配目标账号，以及桌面客户端当前运行状态，可点击“重新检测”。检查仅在本机读取文件和进程状态，不联网、不触发登录或重启；客户端内的身份仍须在 Codex 中核对，进程运行与重启成功均不代表身份已确认。最近一次切换检查仅保留在本次应用运行期间。

### 4. 跨设备迁移（可选）

一次性 Auth 迁移支持二维码与剪贴板。发送前应停止发送端的 Codex 会话；接收端导入后会立即刷新并校验账号，写入完成后请重启 Codex 使切换生效。需要两端长期使用时，请在接收设备重新发起 OAuth 授权。

## 实验室

侧边栏“实验室”集中管理实验功能。当前提供“本地 Codex 登录”，默认关闭，开关仅保存在本机。启用后可在登录窗口选择本地 Codex 或 OAuth；关闭后恢复为 OAuth 登录，不删除已保存的账号。

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

订阅额度默认在后台自动更新：应用启动后查询一次，之后每 15 分钟刷新已保存账号，无需进入额度页，切换页面也不会重复触发查询。“设置 → 用量与额度”仅保留一个“后台自动刷新”开关；旧版本中已主动关闭自动刷新的用户会保留关闭选择。各页面仍可手动刷新，Token 用量在进入页面时读取本机数据。

后台刷新会避开进行中的登录，并与切换、迁移和额度查询协调；离线或查询失败时延后重试。手动查询会顺延对应账号的下一次刷新；失败会逐次加倍重试间隔，最长 2 小时，成功后恢复 15 分钟，已有结果保留。退出应用后停止，窗口隐藏、最小化或 WebView 重载不会停止 Rust 定时任务；系统休眠可能延迟刷新，恢复后不补跑错过的轮次。后台开关保存在本机 `quota-refresh.v1.json`，首次启动迁移旧版偏好。关闭开关不取消已发出的查询。

账号数据支持全部或逐个刷新，不同账号最多 2 个并发，同一账号串行查询。失败时保留上次成功结果及原查询时间；首次失败会提示重试，缺失数据不会当成零。并非所有账号都返回完整额度字段；遇到限流请稍后重试。

### 额度变化记录

在“订阅额度”账号行点击历史图标，或进入“账号详情 → 变化记录”，查看近 24 小时、7 天或 30 天的观测趋势和明细。每次成功查询只记录实际返回的窗口百分比、时间、来源和套餐信息，不补造历史。手动和后台自动查询都会记录；查看历史本身不发起在线查询。缺失或失败的查询不写入零值。

仅在账号、额度池、主/次窗口、来源、套餐、窗口时长和明确的重置时间一致时计算百分点变化。跨期、来源变化或信息不足会断开趋势线；剩余回升只表示观测值增加，不据此认定发生了重置，也不归因到某台设备或任务。

`quota-history.v1.json` 保存在本机应用数据目录，与账号库分开；最多保留近 30 天、12,000 个窗口观测值、每账号 2,000 个，文件上限 8 MiB，访问或写入时淘汰过期及最旧记录，不会无限增长。每个额度窗口分别计数，刷新越频繁或窗口越多，达到数量上限后可回看的天数越少。历史持久化失败会单独提示，成功的额度查询与已刷新凭据仍然保留。详情页可确认清空所有账号的历史，账号与凭据不受影响；移除账号时同时尝试清理其历史；清理失败会单独提示，不阻止账号删除，也不改动其他账号凭据。损坏的历史不会被静默覆盖，可通过清空操作重新开始。

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

可额外选择对比模型 B，与参考模型 A 使用相同的账号范围、Token 总量、输入占比和缓存比例，分别展示近 7 / 30 天的零缓存与当前缓存场景费用，以及 B 相对 A 的美元差额和百分比。支持交换 A / B；可展开查看两个模型的费用拆分及单价。缺少缓存单价时仅保留可计算的场景，缺失用量不会按零比较；A 的费用为零时不计算差价百分比。这是相同用量下的单价对照，不代表两个模型完成同一任务时的实际 Token 消耗或效果相同。

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

- 保存当前账号、切换、订阅额度查询及价值模拟的账号用量查询仅支持 `cli_auth_credentials_store = "file"`；本地 Token 用量不受此限制
- 本机 Codex 登录需要支持 `account/login/start` 的 App Server；具体能力以安装版本为准，当前已验证 macOS 初始化协议，真实授权和 Windows/Linux 仍需人工冒烟
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

公开在线演示使用独立的 `demo` 构建，复用虚构账号和用量数据，允许页面浏览、主题切换及费用模拟。登录、账号迁移、账号切换、本机配置写入和更新安装均禁用，不读取本机凭据或连接业务后端。

```bash
npm run dev:demo      # 开发只读演示界面
npm run test:demo     # 验证数据隔离和只读边界
npm run build:demo    # 输出到 dist-demo，与桌面版 dist 分开
npm run preview:demo  # 本地检查构建产物
```

部署到 EdgeOne Pages 时，只上传 `dist-demo`。已登录 EdgeOne CLI 后可运行：

```bash
PAGES_SOURCE=skills edgeone makers deploy dist-demo -n codex-auth-switch-preview --json
```

自动更新由 [部署在线预览](.github/workflows/deploy-preview.yml) 工作流完成。先在仓库的 **Settings → Secrets and variables → Actions** 中添加 `EDGEONE_API_TOKEN`，值为 EdgeOne 控制台创建的 API Token。此凭据仅在部署步骤使用，不写入前端构建产物。

`main` 上的前端、演示测试或构建配置改动会触发验证、构建及生产部署，更新 [在线预览](https://codex-auth-switch.mintimate.cn)。PR 只验证构建，不部署；也可在 Actions 中手动运行该工作流，只有选择 `main` 才会部署。工作流使用 Node.js 24 和固定版本的 EdgeOne CLI 1.6.8，并串行完成部署。

仓库中的 `edgeone.json` 也配置了 `npm ci`、`npm run build:demo` 和 `dist-demo`，便于通过代码仓库构建；构建环境需使用 Node.js 22.12+。长期公开入口请绑定自定义域名。预置域名的访问规则见 [EdgeOne 域名说明](https://edgeone.cloud.tencent.com/pages/document/175191784523485184)，部署输出中的完整临时链接不应删去参数或作为永久地址写入 README。

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

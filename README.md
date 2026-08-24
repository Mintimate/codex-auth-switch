# Codex Auth Switch

一个非官方、纯本地的 Codex ChatGPT 多账号切换器。

它解决的不是 OpenAI 订阅或账单管理，而是同一台电脑上多个 Codex ChatGPT 登录之间的保存、切换和用量观察。应用不会代理 Codex 请求；新增账号通过浏览器完成 OpenAI Device Code 授权，无需安装 Codex CLI。

> 本项目与 OpenAI 无隶属、赞助或背书关系。Codex、ChatGPT 和 OpenAI 是其各自权利人的商标。

## 功能

- 检测当前 Codex ChatGPT 登录
- 为当前登录设置本地名称并保存
- 通过浏览器 Device Code 授权添加账号
- 一键切换已保存账号
- 按账号查看订阅额度窗口，单个账号查询失败时独立降级
- 汇总本机 Codex 会话的今天、近 7 天和近 30 天 Token 用量
- 展示 14 天趋势、Token 构成和切换后的账号归属
- 橙色亮色/暗色主题，并支持跟随系统自动切换
- 切换前自动捕获当前账号可能轮换过的令牌
- 重命名或移除非当前账号
- 检测 `file`、`keyring` 和 `auto` 凭据存储模式
- 认证数据只写入本机；登录时直接与 `auth.openai.com` 通信，额度查询直接访问 `chatgpt.com`

## 当前支持范围

首版仅支持文件凭据存储：

```toml
cli_auth_credentials_store = "file"
```

Codex 的 `keyring` 和 `auto` 模式暂不修改，应用会显示明确提示。API Key 登录也不会被当作 ChatGPT 订阅账号保存。

订阅额度使用 ChatGPT 当前的兼容性接口查询，并非 OpenAI 承诺稳定的公开 API；接口变化或账号策略可能使某个账号暂时无法显示额度，但不会影响账号切换和本机 Token 统计。Token 明细只解析 `~/.codex/sessions` 与 `archived_sessions` 中的 `token_count` 元数据，不解析或传递提示词、回复正文。Codex 会话本身没有可靠的历史账号 ID，因此账号归属从本版本开始记录切换时间线，之前的数据会显示为“历史未归属”。

## 安全模型

Codex 官方文件模式将登录缓存保存在 `CODEX_HOME/auth.json`，默认路径为 `~/.codex/auth.json`。该文件包含访问令牌，应当像密码一样保护。

Codex Auth Switch 会在自己的应用数据目录保存账号快照：

- macOS/Linux 上目录权限设置为 `0700`
- 账号库和临时认证文件权限设置为 `0600`
- 前端只能读取脱敏后的账号摘要，无法获取令牌
- 本机 Token 解析完全在 Rust 后端完成，前端只接收聚合数字
- 日志和错误消息不会包含令牌
- macOS/Linux 切换使用同目录原子替换

如果设备被其他高权限用户控制，本地文件权限无法提供额外保护。系统钥匙串支持列入后续路线图。

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

验证：

```bash
npm run typecheck
npm run build:web
cd src-tauri && cargo test
```

## 项目结构

```text
src/                    React 桌面界面
src-tauri/src/manager.rs 账号库、认证校验与切换核心
src-tauri/src/usage.rs   本机会话 Token 聚合
src-tauri/src/lib.rs      Tauri 命令边界
```

## 参考

- [OpenAI 官方认证文档](https://learn.chatgpt.com/docs/auth)
- [OpenAI Codex 方案与用量说明](https://learn.chatgpt.com/docs/pricing)

官方文档将 Device Code 登录标记为 Beta，并说明可能需要用户或工作区管理员先在 ChatGPT 安全设置中启用。官方用量说明确认订阅限制会随模型、上下文和工具变化，且本地与云端任务共享用量窗口。本文档确认的是这些产品能力；应用使用的具体 HTTP 端点和字段来自兼容性实现，不应视为 OpenAI 对公开 API 稳定性的承诺。

## License

MIT

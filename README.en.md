<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/app-icon-dark.svg">
  <img src="./docs/images/app-icon.svg" width="144" height="144" alt="Codex Auth Switch app icon">
</picture>

</div>

<h1 align="center">Codex Auth Switch</h1>

<p align="center"><a href="./README.md">简体中文</a> · <strong>English</strong></p>
<p align="center">A local-only account switcher for Codex ChatGPT</p>

<p align="center">
  <a href="https://github.com/Mintimate/codex-auth-switch/releases/latest">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#security-boundaries">Security</a> ·
  <a href="#development">Development</a> ·
  <a href="https://github.com/Mintimate/codex-auth-switch/issues">Report an issue</a>
</p>

![Codex Auth Switch account page](docs/images/dashboard-light.jpg)

> Screenshots use built-in preview data and contain no real accounts, tokens, or authentication data.

Codex Auth Switch saves and switches multiple Codex ChatGPT logins on one device. It also provides local Token usage, subscription quotas, and environment diagnostics. It does not proxy Codex requests, collect telemetry, or manage API keys, subscription billing, or workspace seats.

> [!IMPORTANT]
> This project is not affiliated with, sponsored by, or endorsed by OpenAI. Codex, ChatGPT, and OpenAI are trademarks of their respective owners.

## Highlights

- Save, rename, and switch local accounts while preserving rotated tokens before each switch
- Add an account through browser-based Device Code authorization without entering a password in the app
- Summarize local session Tokens for today, 7 days, and 30 days, split by account and model provider
- Show quota windows, recovery timelines, 7-day Tokens, and a one-year activity heatmap
- Transfer Auth once through a QR code or clipboard, with legacy CAS2 import compatibility
- Run read-only diagnostics and use light/dark themes, Chinese/English UI, and signed updates

## Interface Preview

| Token usage                                                   | Subscription quotas                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| ![Codex Auth Switch Token usage](docs/images/usage-light.jpg) | ![Codex Auth Switch subscription quotas](docs/images/quota-light.jpg) |

## Download and Install

Download the installer for your system from [Releases](https://github.com/Mintimate/codex-auth-switch/releases/latest).

| System  | Architecture          | Format                        |
| ------- | --------------------- | ----------------------------- |
| macOS   | Apple Silicon / Intel | `.dmg`                        |
| Windows | x64                   | `.exe` / `.msi`               |
| Linux   | x64                   | `.AppImage` / `.deb` / `.rpm` |

The macOS package uses an ad hoc signature, so first launch may require approval in System Settings → Privacy & Security. Download only from this project's Releases page.

## Quick Start

### 1. Enable file-based credential storage

Add the following to `CODEX_HOME/config.toml` (default: `~/.codex/config.toml`):

```toml
cli_auth_credentials_store = "file"
```

The app does not modify `keyring` or `auto`, and API Key authentication is never saved as a subscription account.

### 2. Save or add an account

Open the app to save the current Codex ChatGPT login, or select **Add account** and complete Device Code authorization in a browser.

### 3. Switch accounts

Select **Switch to this account** in the local vault. The app validates the target and atomically replaces the `auth.json` used by Codex.

### 4. Transfer to another device (optional)

One-time Auth transfer supports QR codes and the clipboard. Stop Codex sessions on the sending device first; the receiver immediately refreshes and validates the account during import. For ongoing access on both devices, start a new OAuth authorization on the receiving device instead.

## Security Boundaries

```text
CODEX_HOME/auth.json
        ↕ local read / atomic replacement
Codex Auth Switch (Tauri + Rust)
        ↕ local account vault
accounts.v1.json
```

- Account snapshots, Token aggregation, and diagnostics stay on the device; there is no project-operated backend, telemetry, or analytics
- Rust handles authentication reads, validation, transfer, and writes; raw tokens never enter the frontend or logs
- On macOS/Linux, the app-data directory uses `0700`, while the vault and temporary credential files use `0600`
- API Key authentication remains separate from ChatGPT subscription authentication
- Usage scans read only `token_count` and `session_meta.model_provider`; prompts and responses are not retained
- Subscription data prefers the local Codex App Server; direct HTTP fallback is an isolated compatibility implementation, not a guaranteed stable public API

> [!WARNING]
> OAuth pairing codes and one-time Auth transfers can grant account access. Share them only with the intended account owner, and stop using the account on the sending device after a successful transfer.

## Current Limitations

- Only `cli_auth_credentials_store = "file"` is supported
- Device Code login is still beta and may need to be enabled by the user or workspace administrator
- The official App Server does not provide subscription expiry, and local Token totals are not the official subscription quota
- Historical sessions lack reliable account IDs, so attribution begins after the app starts recording the switch timeline

## Development

Requires Node.js 20+, Rust stable, npm, and the platform dependencies for Tauri 2.

```bash
npm install
npm run dev
```

Checks before committing:

```bash
npm run format
npm run typecheck
npm run build:web

cd src-tauri
cargo fmt --all
cargo test
```

Use `npm run release <version>` to synchronize versions, create the release commit, and tag it. Pushing a `v*` tag lets CI build, sign, and publish installers for every platform.

## License

[MIT](LICENSE)

# Security Policy

## Sensitive data

The account vault and Codex `auth.json` contain access and refresh tokens. Never attach either file to an issue, paste it into chat, or commit it to a repository.

OAuth pairing is the recommended way to authorize another device: start pairing on the receiving device and give the browser URL and short-lived code only to the intended account owner. Before a one-time Auth transfer, stop Codex sessions on the sending device. The app then force-refreshes the selected credentials and emits the same compact CAS3 payload through text and QR. CAS3 contains only the ID and refresh tokens required for redemption. The receiver immediately refreshes those credentials, verifies the account identity, and rebuilds a complete local Auth before it writes or switches anything. After import, the sending device must not use that account again; use OAuth pairing instead when both devices need ongoing access.

When reporting a bug:

- include the application and Codex versions;
- include the configured credential storage mode;
- redact account IDs, email addresses, tokens, and local usernames;
- do not include the contents of `auth.json` or `accounts.v1.json`.

## Scope

The application is local-only and has no telemetry or project-operated backend. During sign-in it communicates directly with `auth.openai.com`. When the user opens or refreshes usage statistics, it sends each saved account's access token and account ID directly to `chatgpt.com` to query that account's quota window. Credentials are never sent to a project-operated service and are written only to local storage.

Local token statistics extract only `token_count` fields and `session_meta.model_provider` from Codex JSONL session files. Deserialization uses narrow structures that discard all other fields; prompts, model responses, base instructions, and other session content are neither retained nor sent to the frontend. Only aggregated token counts and model-provider labels cross the Rust-to-frontend boundary.

File permissions reduce accidental disclosure but do not protect credentials from another process running as the same user or from an administrator with access to the device.

Normal frontend status calls receive only redacted account summaries. During OAuth pairing, the frontend receives only the browser URL, short-lived user code, expiration, and polling interval. During an explicit one-time Auth transfer, Rust writes and reads transfer text through the system clipboard and returns only a rendered QR image to the WebView. Raw token strings are never returned through Tauri commands, displayed, or logged. New transfers use CAS3; legacy CAS2 text and QR codes remain import-compatible. CAS3 import requires direct network access to the authentication service and leaves the existing local login unchanged if redemption, identity validation, or Auth reconstruction fails.

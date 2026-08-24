# Security Policy

## Sensitive data

The account vault and Codex `auth.json` contain access and refresh tokens. Never attach either file to an issue, paste it into chat, or commit it to a repository.

When reporting a bug:

- include the application and Codex versions;
- include the configured credential storage mode;
- redact account IDs, email addresses, tokens, and local usernames;
- do not include the contents of `auth.json` or `accounts.v1.json`.

## Scope

The application is local-only and has no telemetry or project-operated backend. During sign-in it communicates directly with `auth.openai.com`. When the user opens or refreshes usage statistics, it sends each saved account's access token and account ID directly to `chatgpt.com` to query that account's quota window. Credentials are never sent to a project-operated service and are written only to local storage.

Local token statistics are calculated by extracting only `token_count` event metadata from Codex JSONL session files. Lines without `token_count` are discarded before JSON parsing; prompt text, model responses, and other session content are not parsed. Only aggregated token counts cross the Rust-to-frontend boundary.

File permissions reduce accidental disclosure but do not protect credentials from another process running as the same user or from an administrator with access to the device.

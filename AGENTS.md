# Repository instructions

- Use Simplified Chinese for user-facing product copy and repository discussions when possible.
- Keep the product local-only. Do not add telemetry, analytics, or a backend service.
- Never print, serialize to frontend, or include authentication tokens in errors or logs.
- Keep Device OAuth and quota endpoints and wire formats isolated as compatibility layers. Do not describe them as officially guaranteed public APIs.
- Device OAuth may only request the authentication data needed for the local Codex cache.
- Keep API Key authentication separate from ChatGPT subscription authentication.
- Run `npm run format`, `npm run typecheck`, and `npm run build:web` after frontend changes.
- Run `cargo fmt --all` and `cargo test` after Rust changes.

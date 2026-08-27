# Repository instructions

- Use Simplified Chinese for user-facing product copy and repository discussions when possible.
- Keep the product local-only. Do not add telemetry, analytics, or a backend service.
- Never print, serialize to frontend, or include authentication tokens in errors or logs.
- Keep Device OAuth and quota endpoints and wire formats isolated as compatibility layers. Do not describe them as officially guaranteed public APIs.
- Device OAuth may only request the authentication data needed for the local Codex cache.
- Keep API Key authentication separate from ChatGPT subscription authentication.
- Run `npm run format`, `npm run typecheck`, and `npm run build:web` after frontend changes.
- Run `cargo fmt --all` and `cargo test` after Rust changes.

## Releasing

- Bump versions only with `npm run bump <version>` (files only) or `npm run release <version>` (files, commit, and tag). Never hand-edit version numbers.
- The version must stay identical in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. CI reads the version from `tauri.conf.json` and fails when the git tag does not match.
- Never search and replace a version string across `src-tauri/Cargo.lock`. Third-party crates can share the same version number, so only the `codex-auth-switch` package block may be edited.
- Pushing a `v*` tag triggers the release workflow. It builds all platforms, generates release notes, verifies the updater manifest and signatures, promotes the draft release, and mirrors it to CNB. Do not perform these steps by hand.
- For a hand-written changelog, add `docs/release-notes/vX.Y.Z.md` before tagging. Otherwise notes are generated from Conventional Commits.
- Keep `src-tauri/icons/Assets.xcassets` intact. CI compiles it with `actool` to produce the macOS light and dark app icon.

# Validation for 0.1.0-alpha.1

Validated on macOS against the exact upstream commit in compatibility.json, in isolated checkouts with synthetic data. The running installation was not used as a test target.

- Installer: clean preflight/install, repeated apply, exact source restoration, retained database fixture, upstream conflicts, owned-file collisions, dangling symlinks, edited-source removal refusal, live socket refusal, deterministic archive.
- Native execution plus adjacent Docker/restart regression suites: 113 passed, 4 skipped. The skipped suite is the opt-in Chrome smoke suite; it was not exercised in this packaging run.
- Updated optional OpenCode and OneCLI recipes: host and runner typechecks passed; 61 tests passed, including real Claude and OpenCode runner subprocesses with local model transport fixtures.
- Fresh frozen host dependency installation and host build passed. Runtime tests used the prepared local dependency environment; a complete first-time machine setup was not exercised.
- Distribution allowlist, checksums, secret signatures, home paths, personal identifiers and tailnet addresses reviewed before publication.

This validates local model transport and native enforcement, not every external model service, browser workflow, CLI, or credential gateway combination. A read-only Go client request through the native sandbox and gateway passed with normal TLS verification after the CA environment fix; removing the gateway CA still caused certificate rejection. The native OS boundary regression tests passed again after this fix. Older Go binaries and custom trust stores remain compatibility limits.

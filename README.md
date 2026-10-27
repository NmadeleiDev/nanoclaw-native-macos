# NanoClaw Native macOS

Experimental native macOS execution backend for NanoClaw, packaged as an independent source add-on. Version 0.1.0-alpha.1. This is not an official NanoClaw component or an audited security boundary.

Runs agents under macOS Seatbelt with scoped filesystem writes, per-agent execution policies, isolated runtime homes, supervised lifecycle, and explicit browser and Docker authority. Broad reads are supported; outbound internet can be explicitly enabled. Docker remains the default until an operator selects native execution.

Supports Claude and optional OpenCode, with the updated OneCLI gateway recipe. The public Workspace UI is independent and currently Docker-only; this package uses host CLI configuration and does not require UI code.

## Install

See [installation](docs/installation.md), [compatibility](compatibility.json), [security limits](SECURITY.md), and [removal](REMOVE.md). The installer targets the exact upstream source recorded in compatibility.json. It refuses incompatible or edited integration files. Do not apply it over an existing customized native installation.

This distribution contains generic source, synthetic fixtures, and documentation. No agent data, credentials, local configuration, or personal instruction files are included.

## Development

Run `node release.mjs --check` to audit the distribution, `node --test tests/*.test.mjs` for installer tests, and `node release.mjs --build` for a deterministic allowlisted archive. Installer tests require a local upstream Git checkout through `NANOCLAW_TEST_UPSTREAM`; they never use live databases.

Runtime source and regression tests are in payload/. Integration changes are in integration.patch. See [contributing](CONTRIBUTING.md) and [third-party notices](THIRD_PARTY.md).

## Limits

Native execution shares the host user and kernel; it is not VM isolation. Broad reads can expose readable credentials. Shared macOS user temporary storage is writable for tool compatibility. Open networking includes LAN access. Browser and Docker grants cross additional security boundaries and are disabled by default.

The supervisor configures Go 1.27+ clients to honor the gateway CA bundle, including binaries with older compatibility defaults. Older Go binaries and clients with pinned/custom trust stores may need explicit CA configuration; never disable TLS verification. Native execution does not impose container-style CPU or memory limits.

MIT licensed; dependency licenses remain their own.

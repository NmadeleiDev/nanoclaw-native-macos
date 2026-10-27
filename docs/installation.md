# Installation

Use a separate checkout of the upstream commit in compatibility.json. Back up existing source and data. This alpha supports exact source matching, not arbitrary forks or automatic upgrades.

1. Run `node install.mjs --target /path/to/nanoclaw --check`.
2. Stop that target's host and sessions before changing source. The installer never stops services.
3. Run `node install.mjs --target /path/to/nanoclaw --apply`.
4. In the target run `corepack pnpm install --frozen-lockfile`. Honor upstream dependency build-script approvals; do not bypass its allowlist. Verify the SQLite binding works before starting the host. Install runner dependencies with `bun install --frozen-lockfile` in container/agent-runner when preparing a fresh checkout.
5. Refresh `/add-onecli` using the updated in-tree recipe. Configure the gateway normally. This package updates the recipe, not an already installed gateway module.
6. For OpenCode, refresh `/add-opencode` using the updated recipe and its pinned SDK/CLI versions. Follow the recipe's Bun dependency steps. Claude requires its supported local CLI. Do not copy credentials into source.
7. Run `corepack pnpm run build`, `corepack pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, and `corepack pnpm exec vitest run src/execution/`. On a prepared Mac, set `NANOCLAW_NATIVE_PROVIDER_SMOKE=1` to exercise real provider subprocesses against local fixtures.
8. Start the target, run `ncl runtimes doctor`, and explicitly select native execution through `ncl groups execution update --help`. Read the current policy/revision before updating it. See the installed docs/native-execution.md for the policy format.

Defaults keep network restricted, writes scoped, and browser/Docker authority disabled. General outbound access is an explicit network.mode=open policy decision. Approved tools still obey filesystem restrictions.

Repeating apply with identical installed source is a no-op. Edited source is rejected, including on removal. Provider/gateway recipe refreshes are separate from the source transaction. No live settings or agents are selected automatically.

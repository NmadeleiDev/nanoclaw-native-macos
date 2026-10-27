# Native macOS execution

Status: experimental source add-on. See the add-on README for installation and tested compatibility.

NanoClaw can run a session's Bun runner, provider CLI, built-in tools, child
processes, and local stdio MCP servers directly on macOS under an inherited
Seatbelt policy. Docker remains available alongside it. This is an optional source add-on. A session starts with its agent's default runtime and
can change backend until its first accepted message or execution. After that its
runtime is fixed, including when startup fails. Changing an agent's default
affects new sessions only.

## Configuration

Requires macOS, Node >=22.12, Bun, `/usr/bin/sandbox-exec`, the selected provider,
and a credential gateway that implements the native proxy contribution. The
installed OneCLI integration supplies that contribution. Unsupported providers,
VM requirements, auxiliary containers, and resource-limit requests fail explicitly.
OpenCode uses the project-pinned macOS executable matching its SDK (1.19.4),
independently of Homebrew's major version. Claude uses the host CLI.

Configure this add-on through the host CLI. The public Workspace UI package is
independent; its current Docker-only release does not provide native controls.

The host CLI exposes the same configuration:

```sh
ncl runtimes doctor
ncl groups execution get --id <agent-id>
ncl groups execution update --id <agent-id> --runtime-driver native-macos
ncl groups execution update --id <agent-id> --policy-file policy.json --revision 0
ncl sessions execution get --id <session-id>
```

A complete policy document is required; unknown keys and stale revisions fail.
For example:

```json
{
  "version": 1,
  "filesystem": {
    "readDefault": "allow",
    "allowRead": [],
    "denyRead": ["/Users/example/.ssh", "/Users/example/.aws"],
    "allowWrite": ["/Users/example/projects/demo"],
    "denyWrite": ["/Users/example/projects/demo/.env"]
  },
  "network": {
    "allow": ["registry.npmjs.org:443", "*.github.com:443"],
    "deny": [],
    "unknown": "ask",
    "localConnectPorts": [3000],
    "listenPorts": [5173]
  },
  "tools": {"default": "allow", "allow": [], "deny": ["mcp:private:*"]},
  "docker": {"unrestricted": false},
  "browser": {"hostChrome": false}
}
```

Install, agent, and session rules combine. Explicit denies and restrictive defaults
survive child-scope grants. Paths are absolute; `..`, control characters, malformed
ports, and unknown fields are rejected. Domain rules optionally select a port;
`*.example.com` covers subdomains, not the apex. Tool rules use `*` patterns:
`builtin:Bash`, `mcp:server:tool`, `mcp:nanoclaw:tool`, and `ncl:groups-get`.
Tool names restrict provider tool dispatch; allowing a shell still permits equivalent
operations through programs within its filesystem and network boundary.

The chosen default deliberately permits broad filesystem reads, including host
credentials. Deny sensitive paths explicitly, or select default-deny reads and
add allow rules. Runtime and system files needed to start are included in the
host's baseline read grants. Writes default to the agent workspace, shared memory,
`instructions.prepend.md`, outbound mailbox, private home/cache/temp directories,
and writable attachments. For sandboxed processes, host source, policy, generated
runtime configuration, inbound mailbox, and other existing agent/session state
are protected. Gateway trust/stub source files remain host-protected. Copies for
the agent are created inside Seatbelt, so symlinks cannot redirect an unrestricted
host write; those copies are agent-writable and refreshed on wake.
Read-only attachments add write denies.

## Agent home

Every native session of an agent uses the same persistent `$HOME` at
`groups/<agent-folder>/.home/`. Git configuration, CLI settings,
installed user tools, and XDG data/config/cache directories belong to the agent,
survive runner restarts, and are shared across its conversations and provider
switches. The entire agent group directory is readable and writable by default,
including this home, provider settings, instructions, and plugin files. Explicit
operator denies and read-only attachment grants still apply. Files materialized from the
host database (such as `container.json`) may be regenerated on wake; editing them
does not change the database or grant sandbox permissions. This home is separate
from the operator's macOS home and from other agents' homes.

Temporary directories, mailbox configuration, generated wrappers, and runtime
controls remain per session. Concurrent conversations share home files, so tools
must use their normal file locking when changing shared configuration. Session
termination does not remove the agent home. The `.home` directory itself must be
a real directory, so an agent cannot redirect its baseline home grant through a
symlink. Older homes, if any, are left untouched and are not merged automatically.

## Network and approvals

All external connections go through the session's Sandbox Runtime proxy and then
the configured credential gateway. Model-provider authorities are included in the
runtime baseline; explicit denies still win. Credentials remain gateway-owned.
Unknown destinations request a decision from an authenticated operator, with
connection, session, agent, and deny choices. Pending requests are bounded,
deduplicated, and expire after two minutes. Policies are rechecked when deciding;
existing session grants do not override a new deny.

Loopback connections and listening ports are separate explicit grants (1024–65535).
Provider and automation-stream ports are host-assigned per session. The host browser has one assigned loopback control port per agent. A listen grant is
**not a promise of loopback-only exposure**: macOS Seatbelt port rules can permit
wildcard binding and inbound LAN traffic. Bind development servers explicitly to
127.0.0.1 when that is the desired exposure.

The `request_access` MCP tool submits filesystem, local-connect, listen, or Docker
requests; it cannot grant permissions. Filesystem/port changes stop and resume the
runner under a new profile. Interrupted inbound claims are not automatically
retried. The continuation asks the agent to inspect current state before further
actions. This prevents transport retry from blindly repeating a tool operation;
it cannot guarantee an LLM will never choose to repeat one.

Docker daemon access is a separately confirmed **persistent agent grant**. It
lets the daemon mount host files and run workloads beyond this sandbox. Revoking
socket access does not remove existing containers. There is no per-command Docker
allowlist and no claim that daemon-created processes inherit Seatbelt restrictions.

## Supervision and limitations

Each native session has a separate trusted supervisor because Sandbox Runtime
keeps process-global state. The supervisor owns network approvals/proxies, tracks
PID/start-time pairs, closes proxies on shutdown, and stops observed descendants.
It also stops if host IPC disconnects. A durable exclusive lease prevents another
run from starting when the previous cleanup was not verified. Inspect
`data/native/<session>/control/process.json` and the private `runner.log` before
manually clearing a stale `control/lease.json`. Never remove a lease while an old
session might still be alive. Permission saves report cleanup failure explicitly.

Seatbelt is inherited by child processes, including shell commands and local MCP
servers. It is not a VM, a process/resource quota, or a guarantee against OS
vulnerabilities. PID polling is best effort: hostile processes can double-fork
between observations. Native execution cannot promise VM-grade descendant
accounting or revoke an already inherited filesystem profile from an escaped
process. Use Docker/VM isolation when those guarantees are required. Remote MCP
servers execute on their own hosts; their tool names can be disabled, but their
remote side effects are outside this machine's filesystem sandbox.

## Host Chrome exception

Enable **Agent execution → Browser → Host Chrome (outside agent sandbox)** and
save the explicit confirmation. The default is off. Session Access shows the
inherited grant read-only. Old policy documents without `browser` remain off;
only agent policies can grant `browser.hostChrome: true`. Host CLI policy updates
require `--confirm-browser-exception` when enabling it.

Click **Open browser** to open or foreground this agent’s normal Chrome window.
Log in to websites there; the private per-agent profile retains cookies and logins
across browser and NanoClaw restarts. Native conversations share those logins but
use distinct pinned automation tabs. The browser keeps Chrome’s own sandbox and
normal certificate validation. It never copies or attaches to personal Chrome.
Profiles live under `data/native-browser/<agent-hash>/profile/`; revocation,
shutdown, and agent deletion stop the owned browser without deleting its profile.

**This is an explicit exception to the agent’s OS policy.** Chrome runs with the
Mac user’s filesystem and network access. NanoClaw directory restrictions, read
and write denies, domain lists, credential gateway routing, and network prompts
do not constrain Chrome. Raw browser automation can read local files and write
browser downloads beyond the agent’s sandbox. A private profile prevents
accidental sharing; it is not a security boundary against an agent with this
host-access capability. Sandboxed commands and their tool policy remain governed
by the native execution policy.

The host creates a separate browser supervisor, validates ownership of the
loopback control port, and issues browser connections only for live native
sessions whose agent still has the grant. The browser CLI remains inside
Seatbelt; requesting the connection works even when `ncl` is disabled. Chrome
starts only on first use or **Open browser**. Missing executables fail the browser
operation explicitly while other native tools remain available.

Host CLI controls (these never enable the grant):

```sh
ncl groups browser status --id <agent-id>
ncl groups browser open --id <agent-id>
```

Closing Chrome interrupts current browser operations. The next authorized request
reopens the same profile; operations are not automatically replayed. A stale
browser ownership lease blocks replacement and reports an error. Inspect
`data/native-browser/<agent-hash>/control/process.json` and `browser.log` before
clearing a stale `control/lease.json`; never clear it while prior processes may
still be alive. Host shutdown/disconnection stops the owned browser tree. Process
accounting has the best-effort limitations described above.

## Development and verification

The exact Sandbox Runtime 0.0.81 dependency has a pinned pnpm patch that adds
independent local-connect/listen port rules and one read-only virtualization
sysctl needed by Chromium. It also removes SRT’s unused TLS certificate-minting
implementation and rejects `tlsTerminate`: TLS interception belongs to the
credential gateway. This removes the vulnerable `node-forge` dependency entirely.
A scoped override supplies Zod 4.6.7 through SRT’s supported `zod/v3` API. The
production dependency audit reports no advisories after these changes. Keep the patch, lockfile, and runtime version together;
never silently drop the patch during an upgrade. No weakened network/nested
sandbox flags or AppleEvents are enabled.

```sh
pnpm test -- src/execution
NANOCLAW_NATIVE_PROVIDER_SMOKE=1 pnpm test -- src/execution/runner.integration.test.ts
NANOCLAW_HOST_BROWSER_SMOKE=1 pnpm test -- src/execution/browser.integration.test.ts
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

The macOS boundary test exercises broad and default-deny reads, actual denied writes, inherited child
restrictions, blocked loopback connections, and permitted/denied listening ports.
The opt-in provider test runs real Claude/OpenCode processes with isolated homes,
SQLite mailboxes, and a local model fixture; it uses no production credentials.
Runtime tests use isolated fixture databases.

## Instruction snapshots and live project access

Native sessions share an agent HOME, but never a turn-instruction file. Each session
uses `data/native/<session>/tmp/instructions.md`. The host-composed runtime contract
contains no mutable persona; providers load standing instructions and repository
rules at a turn boundary. Claude uses UserPromptSubmit for mutable context, and
OpenCode prepares its session-specific instruction file under its turn lock.
Repository rules are collected from the Git root through the working directory,
using AGENTS.md before CLAUDE.md in each directory. Outside a Git repository, only
the working directory's rules are included. Imported OpenClaw references remain
references. Shared skills are reconciled on spawn; authored skills are retained,
and collisions are reported.



Project directories and network settings are inherited live by native conversations.
Conversation-specific attachments remain separate; old explicit attachments are
preserved. Removing a project grant does not remove an independently granted
conversation or agent permission. Explicit denies win. Project changes report the
linked conversations; Docker network permissions are not represented as enforced.
Project-level settings cannot grant host Chrome or Docker daemon authority.

Permission changes have durable transitions. Pending cleanup blocks replacement
execution; restart recovers incomplete transitions. Interrupted inbound messages
are not replayed; one transition-specific continuation asks the agent to inspect
existing results and resume. Idle sessions are not woken. A remaining process lease
keeps execution blocked rather than being silently removed.

Broad reads remain the default. Native writes additionally deny macOS system and
application paths, operator preferences/LaunchAgents/Keychains, credential settings,
and shell startup files. Host Chrome retains the explicitly granted exception
described above; these runner restrictions do not apply to Chrome.

## Shutdown and inspection failures

Normal native shutdown stops and verifies session descendants before closing the
network proxy. Permission reconfiguration and gateway loss revoke networking
immediately. A later revocation also takes effect during an ordinary shutdown.
Process inspection makes at most three asynchronous attempts, each with a three-second timeout;
failures include the exit status, signal, OS error, and stderr in the runner log.
The polling timer stops when shutdown begins so it cannot interrupt cleanup.

If cleanup cannot be verified, the supervisor terminates its directly owned runner,
closes networking, retains the lease, and retries cleanup under supervision. It
never kills cached PIDs without checking their start times. Replacement execution
remains blocked until cleanup succeeds. Successful cleanup removes the lease,
even when the original reason for shutdown was a runtime failure.

## Generic outbound networking

`network.mode: "open"` permits direct outbound TCP/UDP, including loopback, while
retaining filesystem write protections, Unix-socket controls, and explicit listening
port grants. The default for existing policies is restricted mode. Open mode cannot
be combined with destination denies: saving such a policy fails explicitly rather
than pretending to enforce a restriction that raw sockets could bypass. HTTP proxy
environment variables remain available for credential-gateway clients; native CLIs
can use their normal direct network transports.

Revoking open egress terminates the runner immediately and verifies descendant
cleanup before replacement execution. Closing a proxy alone cannot revoke a raw
socket. Host Chrome remains its separately approved exception.

Process inspection is asynchronous, retries up to three times with three-second
per-attempt timeouts, and coalesces overlapping scans. It does not block the
supervisor event loop. The running supervisor scans once per second and drops
exited process records, preserving start-time checks for live descendants.


## Native macOS compatibility defaults

Open-outbound sessions allow the macOS DNS resolver socket and trust evaluation service used by Go TLS
clients. Certificate validation remains enabled; restricted-network sessions keep
the existing trust-service isolation. This does not make a gateway interception
CA trusted by clients that ignore PEM trust environment variables.

The session-private temporary directory remains the default for TMPDIR/TMP/TEMP
and zsh TMPPREFIX. macOS frameworks that ignore those variables may write to the
OS-resolved per-user temporary directory. Its canonical path and ownership are
validated on the host. This grants writes to that user's shared temporary files,
not all of /tmp or /var/folders. Explicit deny-write rules still take precedence.


### Go certificate bundles on macOS

Native processes with a gateway-provided `SSL_CERT_FILE` or `SSL_CERT_DIR` receive
`GODEBUG=x509sslcertoverrideplatform=1`, preserving unrelated settings. This makes
Go 1.27+ binaries honor the scoped CA bundle even with older module compatibility
defaults. Chain and hostname verification remain enabled; Keychain is unchanged.
Older Go binaries and clients with custom/pinned trust need their own supported
CA configuration. See https://go.dev/doc/godebug for Go's documented behavior.

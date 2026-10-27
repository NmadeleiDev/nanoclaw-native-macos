/** One process per session: SRT owns module-global state and must not be shared. */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { OwnedProcessTree } from './owned-processes.js';
import { drainNativeSession } from './shutdown.js';
import type { NativeProcessSpec } from './types.js';
import { networkDecision, parseExecutionPolicy } from './policy.js';

const configPath = process.argv[2];
let child: ChildProcess | undefined;
let stopping = false;
const pending = new Map<string, (allow: boolean) => void>();
let stateDirectory: string | undefined;
let tree: OwnedProcessTree | undefined;
let tracking: ReturnType<typeof setInterval> | undefined;
let shutdown: Promise<void> | undefined;
let networkClosed: Promise<void> | undefined;
function closeNetwork(): Promise<void> {
  return (networkClosed ??= SandboxManager.reset());
}
function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (process.connected) process.send?.({ type: 'failure', message });
  console.error(`[native-supervisor] ${message}`);
}
function stop(code = 0, revoke = false): Promise<void> {
  // A revocation may arrive while ordinary cleanup is already in progress.
  if (revoke) {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    void closeNetwork().catch(reportFailure);
  }
  if (shutdown) return shutdown;
  stopping = true;
  clearInterval(tracking);
  for (const resolve of pending.values()) resolve(false);
  pending.clear();
  shutdown = (async () => {
    await drainNativeSession({
      revoke,
      stopProcesses: async () => {
        await tree?.stop();
      },
      closeNetwork,
      terminateRunner: () => {
        if (child && child.exitCode === null) child.kill('SIGKILL');
      },
      reportFailure,
    });
    if (stateDirectory) fs.rmSync(path.join(stateDirectory, 'lease.json'), { force: true });
    process.exit(code);
  })();
  return shutdown;
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || !process.send || !configPath)
    throw new Error('Native supervisor requires macOS and a host IPC channel');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as NativeProcessSpec;
  // SRT's mandatory project-config protections belong to host control state.
  // The agent owns its entire group workspace, including its private .home.
  // Explicit operator filesystem denies remain enforced everywhere.
  process.chdir(config.stateDirectory);
  stateDirectory = config.stateDirectory;
  tree = new OwnedProcessTree(stateDirectory);
  config.policy = parseExecutionPolicy(config.policy);
  // Start from the host-constructed environment; never inherit the operator shell.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, config.env);
  // Go 1.27+ binaries may retain pre-1.27 defaults through their go.mod.
  // Honor the gateway's scoped CA bundle without changing the host Keychain
  // or disabling certificate/hostname verification. Preserve unrelated knobs.
  if (config.env.SSL_CERT_FILE || config.env.SSL_CERT_DIR) {
    process.env.GODEBUG = [
      ...(config.env.GODEBUG ?? '')
        .split(',')
        .filter((entry) => entry && !entry.startsWith('x509sslcertoverrideplatform=')),
      'x509sslcertoverrideplatform=1',
    ].join(',');
  }

  // SRT derives TMPDIR from Claude's override rather than the incoming TMPDIR.
  // Keep every tool's temporary files inside this session's private grant.
  process.env.CLAUDE_CODE_TMPDIR = config.env.TMPDIR;
  process.env.TMPPREFIX = path.join(config.env.TMPDIR, 'zsh');
  const ask = async ({ host, port = 443 }: { host: string; port?: number }): Promise<boolean> => {
    const decision = networkDecision(config.policy, host, port);
    if (decision !== 'ask') return decision === 'allow';
    if (stopping || pending.size >= 20 || !process.connected) return false;
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(false);
      }, 120_000);
      pending.set(id, (allow) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(allow);
      });
      process.send!({ type: 'network', id, host, port });
    });
  };
  process.on('message', (message: { type?: unknown; id?: unknown; allow?: unknown; revoke?: unknown }) => {
    if (message?.type === 'network-decision' && typeof message.id === 'string')
      pending.get(message.id)?.(message.allow === true);
    if (message?.type === 'stop') void stop(0, message.revoke === true).catch(fail);
  });
  process.on('disconnect', () => void stop(1).catch(fail));
  process.on('SIGTERM', () => void stop().catch(fail));
  process.on('SIGINT', () => void stop().catch(fail));
  const policy = config.policy;
  const denyRead = [...policy.filesystem.denyRead, ...config.denyRead];
  const srtConfig = {
    network: {
      allowOutboundInternet: policy.network.mode === 'open',
      allowedDomains: policy.network.allow,
      deniedDomains: policy.network.deny,
      parentProxy: config.parentProxy,
      allowLocalBinding: false,
      localConnectPorts: [
        ...policy.network.localConnectPorts,
        ...config.internalPorts,
        ...(config.internalConnectPorts ?? []),
      ],
      listenPorts: [...policy.network.listenPorts, ...config.internalPorts],
      allowUnixSockets: [
        ...config.unixSockets,
        ...(policy.network.mode === 'open' ? ['/private/var/run/mDNSResponder'] : []),
      ],
    },
    filesystem: {
      denyRead: policy.filesystem.readDefault === 'deny' ? ['/'] : [],
      allowRead: [...config.readRoots, ...policy.filesystem.allowRead],
      allowWrite: [...config.writeRoots, ...policy.filesystem.allowWrite],
      denyWrite: [...config.denyWrite, ...policy.filesystem.denyWrite],
    },
    // Deny-only entries cannot be reopened by an allowRead carve-out.
    credentials: { files: denyRead.map((p) => ({ path: p, mode: 'deny' as const })) },
    allowAppleEvents: false,
    // Open egress already permits arbitrary destinations. Allow macOS trust
    // evaluation so native Go clients can verify TLS instead of bypassing it.
    enableWeakerNetworkIsolation: policy.network.mode === 'open',
    enableWeakerNestedSandbox: false,
    allowPty: true,
  } satisfies SandboxRuntimeConfig & {
    network: { allowOutboundInternet: boolean; localConnectPorts: number[]; listenPorts: number[] };
  };
  await SandboxManager.initialize(srtConfig, ask, false);
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  // Never follow agent-planted paths while running as the unrestricted host.
  // Public gateway files are copied only once Seatbelt enforces the policy.
  const initialize = (config.initialFiles ?? []).map(
    ({ source, target }) =>
      `/bin/mkdir -p ${quote(path.dirname(target))} && /bin/cp ${quote(source)} ${quote(target)} && /bin/chmod 600 ${quote(target)}`,
  );
  const command = [...initialize, `exec ${config.command.map(quote).join(' ')}`].join(' && ');
  const wrapped = await SandboxManager.wrapWithSandboxArgv(command, '/bin/bash', undefined, undefined, config.cwd, {
    commandId: randomUUID(),
  });
  child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: config.cwd,
    env: wrapped.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', fail);
  child.on('spawn', async () => {
    try {
      await tree!.track();
    } catch (error) {
      fail(error);
      return;
    }
    fs.writeFileSync(
      path.join(config.stateDirectory, 'applied-policy.json'),
      JSON.stringify({ revision: config.executionRevision, appliedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    if (process.connected) process.send!({ type: 'ready' });
  });
  child.on('exit', (code) => void stop(code ?? 1).catch(fail));
  tracking = setInterval(async () => {
    try {
      await tree!.track();
    } catch (e) {
      fail(e);
    }
  }, 1000).unref();
}
function fail(error: unknown): void {
  reportFailure(error);
  // Never exit merely because cleanup failed: keep the lease and supervisor
  // alive until descendants are confirmed gone.
  if (!stopping) void stop(1).catch(reportFailure);
}
void main().catch(fail);

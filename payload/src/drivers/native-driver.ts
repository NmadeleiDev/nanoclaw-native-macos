import { revokesNativeAccess } from '../execution/shutdown.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, type ChildProcess } from 'node:child_process';
import type {
  DriverCapabilities,
  SessionDriver,
  SessionEvent,
  SessionHandle,
  SessionSpec,
  SessionStatus,
} from './types.js';
import type { NativeSupervisorMessage } from '../execution/types.js';

export class NativeSessionDriver implements SessionDriver {
  readonly kind = 'native-macos';
  private handles = new Map<string, NativeHandle>();
  private listeners = new Set<(e: SessionEvent) => void>();
  constructor(private readonly ask: (key: SessionSpec['key'], host: string, port: number) => Promise<boolean>) {}
  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['native'],
      admissionEnforced: true,
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      unrealized: ['memoryMb', 'cpus', 'pidsLimit', 'shmSizeMb'],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      imageBuild: false,
      nativeProcesses: true,
    };
  }
  async ensureReady(): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('Native execution requires macOS');
    fs.accessSync('/usr/bin/sandbox-exec', fs.constants.X_OK);
    const { NetworkConfigSchema } = await import('@anthropic-ai/sandbox-runtime');
    const probe = NetworkConfigSchema.parse({
      allowOutboundInternet: true,
      allowedDomains: [],
      deniedDomains: [],
      localConnectPorts: [12345],
      listenPorts: [12346],
    }) as Record<string, unknown>;
    if (
      probe.allowOutboundInternet !== true ||
      !Array.isArray(probe.localConnectPorts) ||
      !Array.isArray(probe.listenPorts)
    )
      throw new Error(
        'Native execution requires the pinned Sandbox Runtime port-policy patch; reinstall with the frozen lockfile',
      );
  }
  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    await this.ensureReady();
    if (!spec.native || spec.containers.length || spec.runtimeTier !== 'native')
      throw new Error('Native driver requires an explicit native process specification');
    if (Object.values(spec.resources).some((v) => v !== undefined))
      throw new Error('Native execution cannot enforce Docker resource limits');
    const previous = this.handles.get(spec.key.sessionId);
    if (previous && (await previous.status()).phase === 'running') throw new Error('Native session already running');
    const handle = new NativeHandle(spec, this.ask, (event) => {
      for (const listener of this.listeners) listener(event);
    });
    this.handles.set(spec.key.sessionId, handle);
    return handle;
  }
  async listSessions(installSlug: string) {
    return [...this.handles.values()]
      .filter((h) => h.key.installSlug === installSlug)
      .map((handle) => ({
        handle,
        phase:
          handle.phase === 'running'
            ? ('running' as const)
            : handle.phase === 'ready'
              ? ('starting' as const)
              : ('terminal' as const),
      }));
  }
  watchSessions(installSlug: string, onEvent: (e: SessionEvent) => void) {
    const listener = (e: SessionEvent) => {
      if (e.key.installSlug === installSlug) onEvent(e);
    };
    this.listeners.add(listener);
    return {
      stop: () => {
        this.listeners.delete(listener);
      },
    };
  }
}

class NativeHandle implements SessionHandle {
  readonly key;
  readonly name;
  phase: 'ready' | 'running' | 'stopped' | 'failed' = 'ready';
  private child?: ChildProcess;
  private failure?: string;
  private cleanupConfirmed = false;
  constructor(
    private readonly spec: SessionSpec,
    private readonly ask: (key: SessionSpec['key'], host: string, port: number) => Promise<boolean>,
    private readonly emit: (event: SessionEvent) => void,
  ) {
    this.key = spec.key;
    this.name = `native-${spec.key.sessionId}`;
  }
  async start(): Promise<void> {
    const native = this.spec.native!;
    fs.mkdirSync(native.stateDirectory, { recursive: true, mode: 0o700 });
    const lease = path.join(native.stateDirectory, 'lease.json');
    try {
      fs.writeFileSync(lease, JSON.stringify({ key: this.key, createdAt: new Date().toISOString() }), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      throw new Error(
        `Native execution is blocked by an unverified previous run: ${lease}. Inspect its process.json before clearing the lease.`,
        { cause: error },
      );
    }
    const config = path.join(native.stateDirectory, 'launch.json');
    fs.writeFileSync(config, JSON.stringify(native), { mode: 0o600 });
    const source = fileURLToPath(new URL('../execution/supervisor.js', import.meta.url));
    const executable = fs.existsSync(source) ? source : source.replace(/\.js$/, '.ts');
    const log = fs.openSync(path.join(path.dirname(native.stateDirectory), 'runner.log'), 'a', 0o600);
    const child = fork(executable, [config], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      execArgv: executable.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [],
      stdio: ['ignore', log, log, 'ipc'],
    });
    fs.closeSync(log);
    this.child = child;
    child.on('exit', (code) => {
      this.cleanupConfirmed = !fs.existsSync(lease);
      if (this.phase !== 'stopped') {
        this.phase = code === 0 ? 'stopped' : 'failed';
      }
      this.emit({ key: this.key, kind: 'terminal' });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Native supervisor startup timed out'));
        void this.stop('startup-timeout');
      }, 20_000);
      child.once('error', (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Native supervisor exited during startup (${code})`));
      });
      child.on('message', (message: NativeSupervisorMessage) => {
        if (message.type === 'ready') {
          clearTimeout(timeout);
          this.phase = 'running';
          resolve();
        }
        if (message.type === 'failure') {
          clearTimeout(timeout);
          this.failure = message.message;
          this.phase = 'failed';
          reject(new Error(message.message));
        }
        if (message.type === 'network')
          void this.ask(this.key, message.host, message.port)
            .then((allow) => {
              if (child.connected) child.send({ type: 'network-decision', id: message.id, allow });
            })
            .catch(() => {
              if (child.connected) child.send({ type: 'network-decision', id: message.id, allow: false });
            });
      });
    });
  }
  async status(): Promise<SessionStatus> {
    return this.phase === 'failed'
      ? { phase: 'failed', failure: { kind: 'runtime-unavailable', retryable: true } }
      : { phase: this.phase };
  }
  async stop(reason: string): Promise<void> {
    if (this.cleanupConfirmed) return;
    if (!this.child || this.child.exitCode !== null) {
      if (fs.existsSync(path.join(this.spec.native!.stateDirectory, 'lease.json')))
        throw new Error(this.failure ?? 'Native cleanup is unverified');
      this.phase = 'stopped';
      return;
    }
    const child = this.child;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Native cleanup could not be verified; replacement execution is blocked')),
        30_000,
      );
      child.once('exit', () => {
        clearTimeout(timeout);
        if (fs.existsSync(path.join(this.spec.native!.stateDirectory, 'lease.json')))
          reject(new Error(this.failure ?? 'Native cleanup is unverified'));
        else resolve();
      });
      if (child.connected) child.send({ type: 'stop', revoke: revokesNativeAccess(reason) });
      else child.kill('SIGTERM');
    });
    this.phase = 'stopped';
  }
  execSpec(_command: string[]): never {
    throw new Error('Interactive attachment is not available for native sessions; use session tools');
  }
}

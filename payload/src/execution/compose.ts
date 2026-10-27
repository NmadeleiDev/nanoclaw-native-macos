import { protectedHostWrites } from './protected-paths.js';
import { reconcileNativeSkills } from './skills.js';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import type { ComposeSessionSpecInput } from '../container-runner.js';
import type { SessionSpec } from '../drivers/types.js';
import { DATA_DIR, GROUPS_DIR, INSTALL_SLUG, TIMEZONE } from '../config.js';
import { getDb } from '../db/connection.js';
import { reserveHostBrowserPort } from './browser.js';
import { ExecutionStore } from './store.js';
import { getProviderHostContract } from '../provider-contracts/registry.js';
import { sessionDir, sessionContextPath } from '../session-manager.js';

/** macOS frameworks use confstr's per-user temp directory, ignoring TMPDIR. */
function nativeSystemTemp(): string {
  const directory = fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], {
    encoding: 'utf8', timeout: 5000,
  }).trim());
  const stat = fs.statSync(directory);
  if (!/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(directory)
      || !stat.isDirectory() || stat.uid !== process.getuid?.())
    throw new Error('macOS returned an invalid per-user temporary directory');
  return directory;
}
/** Runtime controls and preferred temporary files are private to one session. */
export function nativePaths(sessionId: string) {
  const root = path.join(DATA_DIR, 'native', sessionId);
  return {
    root,
    tmp: path.join(root, 'tmp'),
    control: path.join(root, 'control'),
    ipc: path.join(DATA_DIR, 'native-ipc', createHash('sha256').update(sessionId).digest('hex').slice(0, 12)),
  };
}
/** Stable across sessions and provider switches; never points at the operator's HOME. */
export function nativeAgentHome(agentFolder: string): string {
  const home = path.join(fs.realpathSync(path.join(GROUPS_DIR, agentFolder)), '.home');
  try {
    if (!fs.lstatSync(home).isDirectory()) throw new Error(`Native HOME must be a real directory: ${home}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return home;
}
function findExecutable(name: string): string {
  for (const dir of (process.env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.realpathSync(file);
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    }
  }
  throw Object.assign(
    new Error(`Native execution needs ${name} on the host PATH; install/configure it before starting`),
    { code: 'NATIVE_TOOL_MISSING' },
  );
}
async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
/** Protect every sibling on the path to an agent-owned subtree. */
function protectedSiblings(root: string, owned: string): string[] {
  const relative = path.relative(root, owned);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
  const parts = relative.split(path.sep);
  const denied: string[] = [];
  let current = root;
  for (const part of parts) {
    if (fs.existsSync(current))
      for (const entry of fs.readdirSync(current)) if (entry !== part) denied.push(path.join(current, entry));
    current = path.join(current, part);
  }
  return denied;
}
export async function composeNativeSession(input: ComposeSessionSpecInput, skills: string[]): Promise<SessionSpec> {
  const { session, agentGroup, containerConfig, gateway, mailboxEnvironment, contribution } = input;
  const provider = session.agent_provider || containerConfig.provider || 'claude';
  if (containerConfig.runtimeTier === 'vm')
    throw new Error('A VM isolation tier cannot be realized by the native process runtime');
  if (!['claude', 'opencode'].includes(provider))
    throw new Error(`Provider ${provider} has no validated native runtime`);
  if (containerConfig.packages.apt.length || containerConfig.packages.npm.length)
    throw new Error(
      'Docker package lists cannot be installed by native execution. Configure host tools explicitly or use a Docker session.',
    );
  if (gateway.containers?.length || !gateway.nativeProxy)
    throw new Error('The selected gateway cannot supply native credential-proxy execution');
  const dirs = { ...nativePaths(session.id), home: nativeAgentHome(agentGroup.folder) };
  for (const dir of [dirs.home, dirs.tmp, dirs.control, dirs.ipc]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const group = fs.realpathSync(path.join(GROUPS_DIR, agentGroup.folder));
  const source = fs.realpathSync(path.join(process.cwd(), 'container/agent-runner/src'));
  const state = sessionDir(agentGroup.id, session.id);
  const policy = (await new ExecutionStore(getDb()).effective(agentGroup.id, session.id)).policy;
  const executionRevision = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  if (contribution.modelEndpoint) {
    const endpoint = new URL(contribution.modelEndpoint);
    policy.network.allow.push(`${endpoint.hostname}:${endpoint.port || '443'}`);
  }
  const contract = getProviderHostContract(provider);
  for (const domain of contract?.modelDomains ?? []) policy.network.allow.push(`${domain}:443`, `*.${domain}:443`);
  policy.network.allow.push(...(contract?.modelAuthorities ?? []));
  const providerExecutable =
    provider === 'opencode'
      ? fs.realpathSync(path.join(process.cwd(), 'node_modules', `opencode-darwin-${process.arch}`, 'bin/opencode'))
      : findExecutable(provider);
  const executables: Record<string, string> = { bun: findExecutable('bun'), [provider]: providerExecutable };
  const attached = containerConfig.additionalMounts.map((m) => ({ ...m, hostPath: fs.realpathSync(m.hostPath) }));
  // A broad grant must never turn host control state (including future sessions)
  // into agent-writable data. Enumerating today's sibling directories is insufficient.
  const project = fs.realpathSync(process.cwd());
  const owned = [group, dirs.home, dirs.tmp, dirs.ipc];
  for (const rule of [...policy.filesystem.allowWrite, ...attached.filter((m) => !m.readonly).map((m) => m.hostPath)]) {
    const prefix = rule.split(/[?*[{]/, 1)[0];
    let candidate = path.resolve(prefix === rule ? prefix : path.dirname(prefix.endsWith('/') ? prefix + 'x' : prefix));
    const suffix: string[] = [];
    while (!fs.existsSync(candidate)) {
      suffix.unshift(path.basename(candidate));
      candidate = path.dirname(candidate);
    }
    candidate = path.join(fs.realpathSync(candidate), ...suffix);
    const overlaps =
      candidate === project ||
      candidate.startsWith(project + '/') ||
      project.startsWith(candidate.endsWith('/') ? candidate : candidate + '/');
    if (overlaps && !owned.some((root) => candidate === root || candidate.startsWith(root + '/')))
      throw new Error(
        `Write grant overlaps NanoClaw host control state: ${rule}. Grant a separate project directory or this agent's workspace.`,
      );
  }
  const internalPorts = provider === 'opencode' ? [await availablePort()] : [];
  const providerPort = internalPorts[0];
  let browserPort: number | undefined, streamPort: number | undefined;
  if (skills.includes('agent-browser')) {
    if (policy.browser.hostChrome) {
      try {
        executables['agent-browser'] = findExecutable('agent-browser');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'NATIVE_TOOL_MISSING') throw error;
      }
      browserPort = await reserveHostBrowserPort(agentGroup.id);
      streamPort = await availablePort();
      internalPorts.push(streamPort);
    }
  }
  const instructions = path.join(dirs.root, 'instructions.md');
  const doc = path.join(group, 'instructions.runtime.md');
  const nativeText =
    `## Execution environment\n\nYou run directly on macOS under Seatbelt, not inside Docker. Your HOME is ${dirs.home}; host tools use their own configuration paths, which may differ. Filesystem reads are ${policy.filesystem.readDefault === 'allow' ? 'broad' : 'restricted'}; writes require granted paths. Network mode: ${policy.network.mode === 'open' ? 'outbound TCP/UDP and local connections are allowed; listening still requires a grant' : 'restricted destinations; request access when needed'}. Use installed CLIs directly. Do not create unsandboxed helpers or launch agents to bypass a denied operation. Report the exact missing capability. Standing instructions and memory refresh at provider turn boundaries.\n\n` +
    fs
      .readFileSync(doc, 'utf8')
      .replace(
        'Changes to standing instructions take effect after the group container restarts, so say that when confirming an edit.',
        'Changes to standing instructions take effect at the next provider turn boundary.',
      )
      .replaceAll('/workspace/agent', group)
      .replaceAll('/app/src', source)
      .replaceAll('/app/skills', path.join(process.cwd(), 'container/skills'))
      .replaceAll('/workspace', state);
  fs.writeFileSync(instructions, nativeText, { mode: 0o600 });
  const layout = {
    instructions,
    turnInstructions: path.join(dirs.tmp, 'instructions.md'),
    kind: 'native',
    agent: group,
    session: state,
    source,
    config: path.join(dirs.root, 'runner.json'),
    context: sessionContextPath(agentGroup.id, session.id),
    additionalDirectories: attached.map((d) => d.hostPath),
    executables,
    executionPolicy: policy,
  };
  // Generated configuration never shares a writable parent with host policy.
  const pathMappings: [string, string][] = [
    ['/workspace/agent', group],
    ['/app/src', source],
    ['/home/node', dirs.home],
    ...attached.map((m) => [`/workspace/extra/${m.containerPath}`, m.hostPath] as [string, string]),
  ];
  const nativePath = (value: string) => {
    for (const [from, to] of pathMappings)
      if (value === from || value.startsWith(from + '/')) return to + value.slice(from.length);
    return value;
  };
  const mcpServers = Object.fromEntries(
    Object.entries(containerConfig.mcpServers).map(([name, server]) => [
      name,
      server.type === 'http'
        ? server
        : {
            ...server,
            command: nativePath(server.command),
            args: server.args?.map(nativePath),
            env: server.env
              ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, nativePath(v)]))
              : undefined,
            ...(server.cwd ? { cwd: nativePath(server.cwd) } : {}),
            ...(server.pluginRoot ? { pluginRoot: nativePath(server.pluginRoot) } : {}),
          },
    ]),
  );
  const nativeConfig = {
    ...containerConfig,
    mcpServers,
    workspaceWorkingDirectory: nativePath(containerConfig.workspaceWorkingDirectory || group),
  };
  fs.writeFileSync(layout.config, JSON.stringify(nativeConfig), { mode: 0o600 });
  reconcileNativeSkills(group, provider, skills, path.join(process.cwd(), 'container/skills'));
  const env: Record<string, string> = {
    PATH: [
      path.join(dirs.root, 'bin'),
      ...new Set(Object.values(executables).map((f) => path.dirname(f))),
      process.env.PATH || '/usr/bin:/bin',
    ].join(path.delimiter),
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    XDG_DATA_HOME: path.join(dirs.home, '.local/share'),
    XDG_CONFIG_HOME: path.join(dirs.home, '.config'),
    XDG_CACHE_HOME: path.join(dirs.home, '.cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(dirs.home, '.cache/bun'),
    TZ: containerConfig.timezone || TIMEZONE,
    LANG: process.env.LANG || 'en_US.UTF-8',
    ...mailboxEnvironment,
    ...Object.fromEntries(
      Object.entries(contribution.env ?? {}).filter(
        ([k]) =>
          ![
            'HOME',
            'PATH',
            'NO_PROXY',
            'no_proxy',
            'HTTP_PROXY',
            'HTTPS_PROXY',
            'http_proxy',
            'https_proxy',
            'XDG_DATA_HOME',
            'XDG_CONFIG_HOME',
            'XDG_CACHE_HOME',
          ].includes(k),
      ),
    ),
    ...gateway.env,
    NANOCLAW_RUNNER_LAYOUT: JSON.stringify(layout),
  };
  if (providerPort) {
    env.NANOCLAW_PROVIDER_PORT = String(providerPort);
    env.OPENCODE_SERVER_PASSWORD = randomBytes(24).toString('hex');
  }
  if (browserPort) {
    env.AGENT_BROWSER_STREAM_PORT = String(streamPort);
    env.AGENT_BROWSER_SOCKET_DIR = dirs.ipc;
  }
  const bin = path.join(dirs.root, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(
    path.join(bin, 'ncl'),
    `#!/bin/sh\nexec ${quote(executables.bun)} run --no-env-file ${quote(path.join(source, 'cli/ncl.ts'))} "$@"\n`,
    { mode: 0o700 },
  );
  if (skills.includes('agent-browser'))
    fs.writeFileSync(
      path.join(bin, 'agent-browser'),
      `#!/bin/sh\nexec ${quote(executables.bun)} run --no-env-file ${quote(path.join(source, 'native-browser.ts'))} "$@"\n`,
      { mode: 0o700 },
    );
  const protectedFiles = fs
    .readdirSync(process.cwd())
    .filter((n) => !['groups', 'data'].includes(n))
    .map((n) => path.join(process.cwd(), n));
  const dataProtection = fs
    .readdirSync(DATA_DIR)
    .filter((n) => !['native', 'native-ipc', 'v2-sessions'].includes(n))
    .map((n) => path.join(DATA_DIR, n));
  const siblingProtection = [
    ...protectedSiblings(GROUPS_DIR, group),
    ...protectedSiblings(path.join(DATA_DIR, 'v2-sessions'), state),
    ...protectedSiblings(path.join(DATA_DIR, 'native'), dirs.root),
    ...protectedSiblings(path.join(DATA_DIR, 'native-ipc'), dirs.ipc),
  ];
  const denyWrite = [
    ...protectedHostWrites(),
    ...protectedFiles,
    ...dataProtection,
    ...siblingProtection,
    dirs.control,
    layout.config,
    layout.context,
    instructions,
    path.join(state, 'inbound.db'),
    path.join(dirs.root, 'bin'),
    '/tmp/claude',
    '/private/tmp/claude',
    ...(gateway.nativeReadonly ?? []).filter((file) => file !== group && !file.startsWith(group + path.sep)),
    ...attached.filter((d) => d.readonly).map((d) => d.hostPath),
  ];
  const unixSockets: string[] = [dirs.tmp, dirs.ipc];
  if (policy.docker.unrestricted) {
    const socket = process.env.DOCKER_HOST;
    if (socket && !socket.startsWith('unix://'))
      throw new Error('Native Docker grants currently require a local Unix-socket daemon');
    const candidates = socket
      ? [socket.slice(7)]
      : [path.join(process.env.HOME || '', '.docker/run/docker.sock'), '/var/run/docker.sock'];
    const selected = candidates.find((p) => fs.existsSync(p));
    if (!selected) throw new Error('The approved Docker daemon socket is unavailable');
    unixSockets.push(fs.realpathSync(selected));
    env.DOCKER_HOST = `unix://${selected}`;
  }
  return {
    key: { installSlug: INSTALL_SLUG, agentGroupId: agentGroup.id, sessionId: session.id },
    containers: [],
    labels: {},
    network: 'shared-private',
    networkAccess: gateway.networkAccess,
    hardening: 'standard',
    resources: {},
    runtimeTier: 'native',
    stopGraceSeconds: 10,
    native: {
      executionRevision,
      initialFiles: gateway.nativeFiles,
      command: [executables.bun, 'run', '--no-env-file', path.join(source, 'index.ts')],
      cwd: group,
      env,
      policy,
      readRoots: [
        group,
        state,
        source,
        dirs.home,
        layout.config,
        layout.context,
        instructions,
        '/System',
        '/usr',
        '/bin',
        '/sbin',
        '/Library',
        '/opt/homebrew',
        path.join(process.cwd(), 'container/agent-runner/node_modules'),
        ...Object.values(executables).map((f) => path.dirname(path.dirname(f))),
        ...attached.map((d) => d.hostPath),
        ...(gateway.nativeReadonly ?? []),
      ],
      writeRoots: [
        group,
        path.join(state, 'outbound.db'),
        path.join(state, 'outbound.db-journal'),
        path.join(state, 'outbox'),
        path.join(state, '.heartbeat'),
        dirs.home,
        dirs.tmp,
        nativeSystemTemp(),
        dirs.ipc,
        ...attached.filter((d) => !d.readonly).map((d) => d.hostPath),
      ],
      denyRead: [dirs.control],
      denyWrite,
      internalPorts,
      internalConnectPorts: browserPort ? [browserPort] : [],
      unixSockets,
      parentProxy: gateway.nativeProxy,
      stateDirectory: dirs.control,
    },
  };
}

/** Per-agent explicit host-access capability. Profiles are retained on stop/revoke. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, TIMEZONE } from '../config.js';
import { readEnvFile } from '../env.js';
import { getDb } from '../db/connection.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getSession } from '../db/sessions.js';
import { ExecutionStore } from './store.js';
import { browserCommand, browserOwnsPort, type BrowserMessage, type BrowserLaunch } from './browser-process.js';
interface Slot {
  port: number;
  child?: ChildProcess;
  chromePid?: number;
  generation?: string;
  phase: 'stopped' | 'starting' | 'running' | 'failed';
  error?: string;
  transition?: Promise<void>;
}
const slots = new Map<string, Slot>();
export function browserPaths(agentId: string) {
  const id = createHash('sha256').update(agentId).digest('hex').slice(0, 16);
  const root = path.join(DATA_DIR, 'native-browser', id);
  return {
    root,
    profile: path.join(root, 'profile'),
    control: path.join(root, 'control'),
    temporary: path.join(process.cwd(), '.cache', 'native-b-' + id.slice(0, 8)),
  };
}
async function requireGrant(agentId: string) {
  if (!(await getAgentGroup(agentId))) throw new Error('Agent not found');
  if (!(await new ExecutionStore(getDb()).get('agent', agentId)).policy.browser.hostChrome)
    throw new Error('Host Chrome is disabled. Enable the browser exception in Agent execution settings.');
}
function executable() {
  const configured =
    process.env.NANOCLAW_NATIVE_CHROME || readEnvFile(['NANOCLAW_NATIVE_CHROME']).NANOCLAW_NATIVE_CHROME;
  const candidate = [
    configured,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].find((f) => f && fs.existsSync(f));
  if (!candidate) throw new Error('Host Chrome needs Chrome/Chromium; configure NANOCLAW_NATIVE_CHROME');
  fs.accessSync(candidate, fs.constants.X_OK);
  return fs.realpathSync(candidate);
}
async function port() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = (server.address() as net.AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(value)));
    });
  });
}
async function serialized(agentId: string, fn: (slot: Slot) => Promise<void>) {
  let slot = slots.get(agentId);
  if (!slot) {
    slot = { port: await port(), phase: 'stopped' };
    const concurrent = slots.get(agentId);
    if (concurrent) slot = concurrent;
    else slots.set(agentId, slot);
  }
  const previous = slot.transition ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      try {
        await fn(slot!);
      } catch (error) {
        slot!.error = error instanceof Error ? error.message : String(error);
        if (slot!.phase !== 'running') slot!.phase = 'failed';
        throw error;
      }
    });
  slot.transition = next;
  try {
    await next;
  } finally {
    if (slot.transition === next) slot.transition = undefined;
  }
}
async function start(agentId: string, slot: Slot) {
  await requireGrant(agentId);
  if (slot.phase === 'running' && slot.child?.exitCode === null) {
    if (!slot.chromePid || !browserOwnsPort(slot.chromePid, slot.port))
      throw new Error('Browser control port is no longer owned by this agent’s Chrome');
    return;
  }
  if (slot.child?.exitCode === null) throw new Error('Browser cleanup is not verified');
  if (process.platform !== 'darwin') throw new Error('Host Chrome requires macOS');
  const dirs = browserPaths(agentId);
  fs.mkdirSync(dirs.control, { recursive: true, mode: 0o700 });
  const binary = executable();
  const lease = path.join(dirs.control, 'lease.json');
  try {
    fs.writeFileSync(lease, JSON.stringify({ agentId, createdAt: new Date().toISOString() }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    throw new Error(`Browser cleanup is unverified. Inspect ${dirs.control}/process.json before clearing its lease.`, {
      cause: error,
    });
  }
  const config: BrowserLaunch = {
    executable: binary,
    profile: dirs.profile,
    temporary: dirs.temporary,
    control: dirs.control,
    port: slot.port,
    environment: {
      HOME: os.homedir(),
      PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: process.env.LANG || 'en_US.UTF-8',
      TZ: TIMEZONE,
    },
  };
  const file = path.join(dirs.control, 'launch.json');
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const source = fileURLToPath(new URL('./browser-supervisor.js', import.meta.url));
  const supervisor = fs.existsSync(source) ? source : source.replace(/\.js$/, '.ts');
  const log = fs.openSync(path.join(dirs.root, 'browser.log'), 'a', 0o600);
  const child = fork(supervisor, [file], {
    env: { PATH: process.env.PATH },
    execArgv: supervisor.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [],
    stdio: ['ignore', log, log, 'ipc'],
  });
  fs.closeSync(log);
  slot.child = child;
  slot.chromePid = undefined;
  slot.phase = 'starting';
  slot.error = undefined;
  child.on('exit', (code) => {
    slot.phase = code === 0 ? 'stopped' : 'failed';
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      slot.error = 'Host Chrome startup timed out';
      if (child.connected) child.send({ type: 'stop' });
      reject(new Error(slot.error));
    }, 20000);
    child.once('error', (error) => {
      clearTimeout(timer);
      slot.error = error.message;
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(slot.error || `Browser supervisor exited (${code})`));
    });
    child.on('message', (message: BrowserMessage) => {
      if (message.type === 'ready') {
        clearTimeout(timer);
        slot.chromePid = message.pid;
        slot.generation = randomUUID();
        slot.phase = 'running';
        resolve();
      } else if (message.type === 'failure') {
        clearTimeout(timer);
        slot.error = message.message;
        reject(new Error(message.message));
      }
    });
  });
}
export async function reserveHostBrowserPort(agentId: string) {
  await requireGrant(agentId);
  await serialized(agentId, async () => {});
  return slots.get(agentId)!.port;
}
export async function ensureHostBrowser(agentId: string) {
  await requireGrant(agentId);
  await serialized(agentId, (slot) => start(agentId, slot));
  return { endpoint: `http://127.0.0.1:${slots.get(agentId)!.port}`, port: slots.get(agentId)!.port };
}
export async function browserStatus(agentId: string) {
  if (!(await getAgentGroup(agentId))) throw new Error('Agent not found');
  const enabled = (await new ExecutionStore(getDb()).get('agent', agentId)).policy.browser.hostChrome;
  const slot = slots.get(agentId);
  return {
    enabled,
    phase:
      slot?.phase ?? (fs.existsSync(path.join(browserPaths(agentId).control, 'lease.json')) ? 'failed' : 'stopped'),
    error:
      slot?.error ??
      (fs.existsSync(path.join(browserPaths(agentId).control, 'lease.json')) && !slot
        ? 'Unverified prior browser run; inspect its ownership record'
        : undefined),
    profile: browserPaths(agentId).profile,
  };
}
export async function openHostBrowser(agentId: string) {
  const { endpoint } = await ensureHostBrowser(agentId);
  const result = await browserCommand(endpoint, 'Target.getTargets');
  const targets = result.targetInfos as { type: string; targetId: string }[];
  const page = targets.find((t) => t.type === 'page');
  const targetId =
    page?.targetId ?? (await browserCommand(endpoint, 'Target.createTarget', { url: 'about:blank' })).targetId;
  await browserCommand(endpoint, 'Target.activateTarget', { targetId });
  return browserStatus(agentId);
}
export async function stopHostBrowser(agentId: string) {
  if (!slots.has(agentId)) {
    if (fs.existsSync(path.join(browserPaths(agentId).control, 'lease.json')))
      throw new Error('Browser cleanup is unverified; inspect its saved process ownership record');
    return;
  }
  await serialized(agentId, async (slot) => {
    const child = slot.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Host Chrome cleanup could not be verified')), 10000);
        child.once('exit', () => {
          clearTimeout(timer);
          if (fs.existsSync(path.join(browserPaths(agentId).control, 'lease.json')))
            reject(new Error('Browser cleanup lease remains; replacement is blocked'));
          else resolve();
        });
        if (child.connected) child.send({ type: 'stop' });
        else child.kill('SIGTERM');
      });
    }
    if (fs.existsSync(path.join(browserPaths(agentId).control, 'lease.json')))
      throw new Error('Browser cleanup is unverified');
    slot.phase = 'stopped';
    slot.error = undefined;
  });
}
export async function browserConnection(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session || session.status !== 'active' || session.runtime_driver !== 'native-macos')
    throw new Error('Host Chrome connection requires an active native session');
  const connection = await ensureHostBrowser(session.agent_group_id);
  return {
    ...connection,
    browserSession:
      's-' +
      createHash('sha256')
        .update(session.id + ':' + slots.get(session.agent_group_id)!.generation)
        .digest('hex')
        .slice(0, 12),
  };
}
export async function stopAllHostBrowsers() {
  const results = await Promise.allSettled([...slots.keys()].map(stopHostBrowser));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

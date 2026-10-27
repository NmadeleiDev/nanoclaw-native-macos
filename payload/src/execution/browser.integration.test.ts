import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../config.js', async (original) => {
  const actual = await original<typeof import('../config.js')>();
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync('.cache', { recursive: true });
  fixture.root = fs.realpathSync(fs.mkdtempSync(path.resolve('.cache/native-browser-real-')));
  return { ...actual, DATA_DIR: fixture.root };
});
import { initTestDb, closeDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createSession, getSession } from '../db/sessions.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { updateExecutionSettings } from './service.js';
import { DEFAULT_EXECUTION_POLICY } from './policy.js';
import { ensureHostBrowser, stopHostBrowser, browserPaths, openHostBrowser, browserConnection } from './browser.js';
import { browserCommand } from './browser-process.js';
import { NativeSessionDriver } from '../drivers/native-driver.js';
import type { SessionSpec } from '../drivers/types.js';
import { initSessionFolder, sessionDir, sessionContextPath, writeSessionContext } from '../session-manager.js';
import '../mailbox/compose.js';
import './browser-action.js';
import { setDeliveryAdapter, deliverSessionMessages } from '../delivery.js';
const executable = (name: string) => execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
async function wait(check: () => boolean, ms = 10000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('Browser fixture timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
describe.skipIf(process.platform !== 'darwin' || process.env.NANOCLAW_HOST_BROWSER_SMOKE !== '1')(
  'real host Chrome exception',
  () => {
    beforeEach(async () => {
      await runMigrations(await initTestDb());
      setDeliveryAdapter({ deliver: async () => undefined });
      await createAgentGroup({
        id: 'g',
        name: 'Browser fixture',
        folder: 'fixture',
        agent_provider: null,
        created_at: new Date().toISOString(),
      });
      await ensureContainerConfig('g', 'claude');
      const policy = structuredClone(DEFAULT_EXECUTION_POLICY);
      policy.browser.hostChrome = true;
      await updateExecutionSettings('agent', 'g', { policy, revision: 0, confirmBrowserException: true });
    });
    afterEach(async () => {
      const log = path.join(browserPaths('g').root, 'browser.log');
      if (fs.existsSync(log)) fs.copyFileSync(log, '.cache/native-browser-real-diagnostic.log');
      await stopHostBrowser('g');
      fs.rmSync(browserPaths('g').temporary, { recursive: true, force: true });
      await closeDb();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    });
    it('shares a persistent private profile while sandboxed sessions automate separate tabs', async () => {
      const browsers = await Promise.all([ensureHostBrowser('g'), ensureHostBrowser('g')]);
      expect(browsers[0]).toEqual(browsers[1]);
      const endpoint = browsers[0].endpoint;
      const command = await browserCommand(endpoint, 'Browser.getBrowserCommandLine');
      expect(command.arguments).not.toContain('--no-sandbox');
      expect(command.arguments).not.toContain('--headless');
      expect((command.arguments as string[]).some((a) => a.startsWith('--proxy-server'))).toBe(false);
      expect(command.arguments).toContain('--user-data-dir=' + browserPaths('g').profile);
      await browserCommand(endpoint, 'Storage.setCookies', {
        cookies: [
          {
            name: 'native-fixture',
            value: 'persisted',
            domain: '127.0.0.1',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 86400,
          },
        ],
      });
      const api = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<title>${req.url}</title><h1>Native browser ${req.url}</h1>`);
      });
      await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
      const modelPort = (api.address() as { port: number }).port;
      const results: Record<string, unknown>[] = [];
      try {
        for (const id of ['s1', 's2']) {
          await createSession({
            id,
            agent_group_id: 'g',
            messaging_group_id: null,
            thread_id: null,
            agent_provider: null,
            runtime_driver: 'native-macos',
            status: 'active',
            container_status: 'stopped',
            last_active: null,
            created_at: new Date().toISOString(),
          });
          initSessionFolder('g', id);
          writeSessionContext('g', id, null);
          const root = path.join(fixture.root, id);
          for (const d of [
            root,
            path.join(root, 'work'),
            path.join(root, 'home'),
            path.join(root, 'control'),
            path.join(root, 'ipc'),
          ])
            fs.mkdirSync(d, { recursive: true });
          const source = path.resolve('container/agent-runner/src');
          const policy = structuredClone(DEFAULT_EXECUTION_POLICY);
          policy.browser.hostChrome = true;
          policy.network.unknown = 'deny';
          const layout = {
            kind: 'native',
            agent: path.join(root, 'work'),
            session: sessionDir('g', id),
            source,
            config: path.join(root, 'config'),
            context: sessionContextPath('g', id),
            additionalDirectories: [],
            executables: { bun: executable('bun'), 'agent-browser': fs.realpathSync(executable('agent-browser')) },
            executionPolicy: policy,
          };
          const spec: SessionSpec = {
            key: { installSlug: 'fixture', agentGroupId: 'g', sessionId: id },
            containers: [],
            labels: {},
            network: 'shared-private',
            networkAccess: { endpoint: '127.0.0.1', target: { kind: 'host' } },
            hardening: 'standard',
            resources: {},
            runtimeTier: 'native',
            stopGraceSeconds: 10,
            native: {
              command: [
                executable('bun'),
                'run',
                '--no-env-file',
                path.join(source, 'native-browser.ts'),
                'open',
                `http://127.0.0.1:${modelPort}/${id}`,
                '--json',
              ],
              cwd: root,
              env: {
                PATH: process.env.PATH!,
                HOME: path.join(root, 'home'),
                TMPDIR: path.join(root, 'home'),
                NANOCLAW_RUNNER_LAYOUT: JSON.stringify(layout),
                AGENT_BROWSER_SOCKET_DIR: path.join(root, 'ipc'),
              },
              policy,
              readRoots: [fixture.root, source],
              writeRoots: [
                path.join(root, 'work'),
                path.join(root, 'home'),
                path.join(root, 'ipc'),
                path.join(sessionDir('g', id), 'outbound.db'),
                path.join(sessionDir('g', id), 'outbound.db-journal'),
              ],
              denyRead: [path.join(root, 'control')],
              denyWrite: [],
              internalPorts: [],
              internalConnectPorts: [browsers[0].port],
              unixSockets: [path.join(root, 'ipc'), path.join(root, 'home')],
              parentProxy: { http: 'http://127.0.0.1:1', https: 'http://127.0.0.1:1' },
              stateDirectory: path.join(root, 'control'),
            },
          };
          const handle = await new NativeSessionDriver(async () => false).prepare(spec);
          const session = (await getSession(id))!;
          let polling = false;
          const timer = setInterval(() => {
            if (!polling) {
              polling = true;
              void deliverSessionMessages(session).finally(() => {
                polling = false;
              });
            }
          }, 50);
          try {
            await handle.start();
            const log = path.join(root, 'runner.log');
            await wait(() => fs.readFileSync(log, 'utf8').includes('"success"'));
            const text = fs.readFileSync(log, 'utf8');
            const line = text.split('\n').find((line) => line.startsWith('{'))!;
            const result = JSON.parse(line);
            expect(result.success, text).toBe(true);
            results.push(result.data);
          } catch (error) {
            throw new Error(String(error) + '\n' + fs.readFileSync(path.join(root, 'runner.log'), 'utf8'), {
              cause: error,
            });
          } finally {
            clearInterval(timer);
            await handle.stop('browser-fixture');
          }
        }
        expect(results[0].targetId).toBeTruthy();
        expect(results[0].targetId).not.toBe(results[1].targetId);
        const targets = await browserCommand(endpoint, 'Target.getTargets');
        const urls = (targets.targetInfos as { url: string }[]).map((t) => t.url);
        expect(urls).toContain(`http://127.0.0.1:${modelPort}/s1`);
        expect(urls).toContain(`http://127.0.0.1:${modelPort}/s2`);
        const before = await browserCommand(endpoint, 'Storage.getCookies');
        expect(before.cookies).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'native-fixture', value: 'persisted' })]),
        );
        const oldConnection = await browserConnection('s1');
        await openHostBrowser('g');
        await stopHostBrowser('g');
        const reopened = await ensureHostBrowser('g');
        expect(reopened.endpoint).toBe(endpoint);
        expect((await browserConnection('s1')).browserSession).not.toBe(oldConnection.browserSession);
        const cookies = await browserCommand(endpoint, 'Storage.getCookies');
        expect(cookies.cookies).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'native-fixture', value: 'persisted' })]),
        );
        await updateExecutionSettings('agent', 'g', { policy: DEFAULT_EXECUTION_POLICY, revision: 1 });
        await expect(ensureHostBrowser('g')).rejects.toThrow('disabled');
        expect(fs.existsSync(browserPaths('g').profile)).toBe(true);
      } finally {
        api.closeAllConnections();
        await new Promise<void>((r) => api.close(() => r()));
      }
    }, 90000);
    it('does not attach to a foreign listener on its reserved port', async () => {
      const { reserveHostBrowserPort } = await import('./browser.js');
      const port = await reserveHostBrowserPort('g');
      let requests = 0;
      const foreign = http.createServer((_, res) => {
        requests++;
        res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/foreign` }));
      });
      await new Promise<void>((r) => foreign.listen(port, '127.0.0.1', r));
      try {
        await expect(ensureHostBrowser('g')).rejects.toThrow(/did not become ready|cleanup|exited/);
        expect(requests).toBe(0);
      } finally {
        foreign.closeAllConnections();
        await new Promise<void>((r) => foreign.close(() => r()));
      }
    }, 30000);
    it('closes its owned Chrome when the host IPC connection disappears', async () => {
      const { fork } = await import('node:child_process');
      const net = await import('node:net');
      const { browserOwnsPort } = await import('./browser-process.js');
      const dirs = browserPaths('disconnect-fixture');
      fs.mkdirSync(dirs.control, { recursive: true });
      fs.writeFileSync(path.join(dirs.control, 'lease.json'), '{}');
      const listener = net.createServer();
      await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((r) => listener.close(() => r()));
      const config = path.join(dirs.control, 'launch.json');
      fs.writeFileSync(
        config,
        JSON.stringify({
          executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          profile: dirs.profile,
          temporary: dirs.temporary,
          control: dirs.control,
          port,
          environment: { HOME: process.env.HOME, PATH: process.env.PATH },
        }),
      );
      const child = fork(path.resolve('src/execution/browser-supervisor.ts'), [config], {
        env: { PATH: process.env.PATH },
        execArgv: ['--import', import.meta.resolve('tsx')],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let diagnostic = '';
      child.stderr?.on('data', (chunk) => {
        diagnostic += String(chunk);
      });
      try {
        const pid = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Browser did not start: ' + diagnostic)), 20000);
          child.on('message', (m: unknown) => {
            const message = m as { type: string; pid?: number; message?: string };
            if (message.type === 'ready') {
              clearTimeout(timer);
              resolve(message.pid!);
            } else if (message.type === 'failure') {
              clearTimeout(timer);
              reject(new Error(message.message));
            }
          });
          child.once('error', reject);
        });
        expect(browserOwnsPort(pid, port)).toBe(true);
        const exited = new Promise<void>((r) => child.once('exit', () => r()));
        child.disconnect();
        await exited;
        expect(browserOwnsPort(pid, port)).toBe(false);
        expect(fs.existsSync(path.join(dirs.control, 'lease.json'))).toBe(false);
        expect(fs.existsSync(dirs.profile)).toBe(true);
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await new Promise<void>((r) => child.once('exit', () => r()));
        }
        fs.rmSync(dirs.temporary, { recursive: true, force: true });
      }
    }, 30000);
    it('blocks a stale browser lease instead of adopting an unknown process', async () => {
      const lease = path.join(browserPaths('g').control, 'lease.json');
      fs.mkdirSync(path.dirname(lease), { recursive: true });
      fs.writeFileSync(lease, '{}', { flag: 'wx' });
      try {
        await expect(ensureHostBrowser('g')).rejects.toThrow('cleanup is unverified');
        await expect(stopHostBrowser('g')).rejects.toThrow('unverified');
      } finally {
        fs.rmSync(lease, { force: true });
      }
    });
  },
);

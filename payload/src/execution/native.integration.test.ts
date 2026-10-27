import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { afterEach, describe, it, expect } from 'vitest';
import { NativeSessionDriver } from '../drivers/native-driver.js';
import { DEFAULT_EXECUTION_POLICY } from './policy.js';
import type { SessionSpec } from '../drivers/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const wait = async (check: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Native fixture did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(process.platform !== 'darwin')('native OS boundary', () => {
  it.each(['allow', 'deny', 'open'] as const)(
    'enforces real file, socket, and port restrictions with %s reads',
    async (readDefault) => {
      fs.mkdirSync('.cache', { recursive: true });
      const root = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.cache/native-boundary-')));
      roots.push(root);
      const home = path.join(root, 'home'),
        control = path.join(root, 'control'),
        work = path.join(root, 'work');
      for (const dir of [home, control, work]) fs.mkdirSync(dir, { mode: 0o700 });
      const secret = path.join(root, 'secret');
      fs.writeFileSync(secret, 'private');
      const outside = path.join(root, 'outside');
      fs.writeFileSync(outside, 'unchanged');
      const listener = net.createServer();
      await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
      const port = (listener.address() as net.AddressInfo).port;
      const reserve = net.createServer();
      await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
      const allowedPort = (reserve.address() as net.AddressInfo).port;
      await new Promise<void>((r) => reserve.close(() => r()));
      const p = structuredClone(DEFAULT_EXECUTION_POLICY);
      p.filesystem.readDefault = readDefault === 'open' ? 'allow' : readDefault;
      if (readDefault === 'open') p.network.mode = 'open';
      p.network.unknown = 'deny';
      p.network.listenPorts = [allowedPort];
      const results = path.join(work, 'results.json');
      const program = `const fs=require('fs'),net=require('net'),cp=require('child_process');const out={goDebug:process.env.GODEBUG};
      for(const [name,fn] of Object.entries({otherRead:()=>fs.readFileSync(${JSON.stringify(path.resolve('README.md'))}),read:()=>fs.readFileSync(${JSON.stringify(secret)}),write:()=>fs.writeFileSync(${JSON.stringify(outside)},'bad'),allowedWrite:()=>fs.writeFileSync(${JSON.stringify(path.join(work, 'ok'))},'ok')})){try{fn();out[name]='allowed'}catch(e){out[name]=e.code}}
      const child=cp.spawnSync(process.execPath,['-e','require("fs").writeFileSync('+JSON.stringify(${JSON.stringify(outside)})+',"bad")']);out.childWrite=child.status;
      async function connect(){return new Promise(r=>{const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{out.connect='allowed';s.destroy();r()});s.on('error',e=>{out.connect=e.code;r()});})}
      async function bind(n){return new Promise(r=>{const s=net.createServer();s.on('error',e=>{out['bind'+n]=e.code;r()});s.listen(n,'127.0.0.1',()=>{out['bind'+n]='allowed';s.close(r)});})}
      (async()=>{await connect();await bind(${allowedPort});await bind(0);fs.writeFileSync(${JSON.stringify(results)},JSON.stringify(out));})();`;
      const spec: SessionSpec = {
        key: { installSlug: 'fixture', agentGroupId: 'g', sessionId: path.basename(root) },
        labels: {},
        containers: [],
        network: 'shared-private',
        networkAccess: { endpoint: '127.0.0.1', target: { kind: 'host' } },
        hardening: 'standard',
        resources: {},
        runtimeTier: 'native',
        stopGraceSeconds: 1,
        native: {
          command: [process.execPath, '-e', program],
          cwd: work,
          env: {
            PATH: process.env.PATH!,
            HOME: home,
            TMPDIR: home,
            SSL_CERT_FILE: '/etc/ssl/cert.pem',
            GODEBUG: 'http2client=0,x509sslcertoverrideplatform=0',
          },
          policy: p,
          readRoots: [
            root,
            path.dirname(process.execPath),
            '/System',
            '/usr',
            '/bin',
            '/sbin',
            '/Library',
            '/opt/homebrew',
          ],
          writeRoots: [work, home],
          denyRead: [secret, control],
          denyWrite: [],
          internalPorts: [],
          unixSockets: [],
          parentProxy: { http: 'http://127.0.0.1:1', https: 'http://127.0.0.1:1' },
          stateDirectory: control,
        },
      };
      const driver = new NativeSessionDriver(async () => false);
      const handle = await driver.prepare(spec);
      try {
        await handle.start();
        await wait(() => fs.existsSync(results));
        const actual = JSON.parse(fs.readFileSync(results, 'utf8'));
        expect(actual.goDebug).toBe('http2client=0,x509sslcertoverrideplatform=1');
        if (readDefault !== 'deny') expect(actual.otherRead).toBe('allowed');
        else expect(actual.otherRead).toMatch(/EPERM|EACCES/);
        expect(actual.read).toMatch(/EPERM|EACCES/);
        expect(actual.write).toMatch(/EPERM|EACCES/);
        expect(actual.allowedWrite).toBe('allowed');
        expect(actual.childWrite).not.toBe(0);
        if (readDefault === 'open') expect(actual.connect).toBe('allowed');
        else expect(actual.connect).toMatch(/EPERM|EACCES/);
        expect(actual['bind' + allowedPort]).toBe('allowed');
        expect(actual.bind0).toMatch(/EPERM|EACCES/);
        expect(fs.readFileSync(outside, 'utf8')).toBe('unchanged');
      } catch (e) {
        throw new Error(String(e) + '\n' + fs.readFileSync(path.join(root, 'runner.log'), 'utf8'), { cause: e });
      } finally {
        await handle.stop('fixture-done');
        await new Promise<void>((r) => listener.close(() => r()));
      }
    },
    30_000,
  );
});

describe.skipIf(process.platform !== 'darwin')('native lifecycle fencing', () => {
  it.each([0, 65000])(
    'stops observed detached descendants after %i ms and blocks an unverified previous lease',
    async (duration) => {
      fs.mkdirSync('.cache', { recursive: true });
      const root = fs.realpathSync(fs.mkdtempSync(path.resolve('.cache/native-life-')));
      roots.push(root);
      const control = path.join(root, 'control'),
        work = path.join(root, 'work');
      fs.mkdirSync(work);
      fs.mkdirSync(control);
      const pidFile = path.join(work, 'pid');
      const program = `const cp=require('child_process');const child=cp.spawn(process.execPath,['-e','require("fs").writeFileSync('+JSON.stringify(${JSON.stringify(pidFile)})+',String(process.pid));setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();setInterval(()=>{},1000);`;
      const spec: SessionSpec = {
        key: { installSlug: 'fixture', agentGroupId: 'g', sessionId: path.basename(root) },
        labels: {},
        containers: [],
        network: 'shared-private',
        networkAccess: { endpoint: '127.0.0.1', target: { kind: 'host' } },
        hardening: 'standard',
        resources: {},
        runtimeTier: 'native',
        stopGraceSeconds: 1,
        native: {
          command: [process.execPath, '-e', program],
          cwd: work,
          env: { PATH: process.env.PATH!, HOME: work, TMPDIR: work },
          policy: DEFAULT_EXECUTION_POLICY,
          readRoots: [root],
          writeRoots: [work],
          denyRead: [control],
          denyWrite: [],
          internalPorts: [],
          unixSockets: [],
          parentProxy: { http: 'http://127.0.0.1:1', https: 'http://127.0.0.1:1' },
          stateDirectory: control,
        },
      };
      const driver = new NativeSessionDriver(async () => false);
      const handle = await driver.prepare(spec);
      try {
        await handle.start();
        await wait(() => fs.existsSync(pidFile));
        const pid = +fs.readFileSync(pidFile, 'utf8');
        if (duration) {
          await new Promise((resolve) => setTimeout(resolve, duration));
          expect((await handle.status()).phase).toBe('running');
          const snapshot = JSON.parse(fs.readFileSync(path.join(control, 'process.json'), 'utf8'));
          expect(Date.now() - Date.parse(snapshot.updatedAt)).toBeLessThan(5000);
        }
        await handle.stop('test');
        expect(() => process.kill(pid, 0)).toThrow();
        expect(fs.existsSync(path.join(control, 'lease.json'))).toBe(false);
        fs.writeFileSync(path.join(control, 'lease.json'), '{}');
        const blocked = await driver.prepare(spec);
        await expect(blocked.start()).rejects.toThrow('unverified previous run');
      } finally {
        await handle.stop('test-cleanup');
      }
    },
    90_000,
  );
});

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { ExecutionStore } from './store.js';
import { DEFAULT_EXECUTION_POLICY } from './policy.js';
import { composeNativeSession, nativeAgentHome, nativePaths } from './compose.js';
import { NativeSessionDriver } from '../drivers/native-driver.js';
import type { SessionSpec } from '../drivers/types.js';
import type { ComposeSessionSpecInput } from '../container-runner.js';
const fixture = vi.hoisted(() => ({ data: '', groups: '' }));
vi.mock('../config.js', async (original) => {
  const actual = await original<typeof import('../config.js')>();
  const path = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const id = '.native-compose-' + randomUUID();
  fixture.data = path.resolve('data', id);
  fixture.groups = path.resolve('groups', id);
  return { ...actual, DATA_DIR: fixture.data, GROUPS_DIR: fixture.groups };
});
beforeEach(async () => {
  await runMigrations(await initTestDb());
  fs.mkdirSync(fixture.data, { recursive: true });
  fs.mkdirSync(path.join(fixture.groups, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(fixture.groups, 'agent/instructions.runtime.md'), 'Agent at /workspace/agent');
});
afterEach(async () => {
  await closeDb();
  for (const root of [fixture.data, fixture.groups]) fs.rmSync(root, { recursive: true, force: true });
});
function input(): ComposeSessionSpecInput {
  return {
    agentGroup: {
      id: 'g',
      folder: 'agent',
      name: 'Fixture',
      agent_provider: null,
      created_at: new Date().toISOString(),
    },
    session: {
      id: randomUUID(),
      agent_group_id: 'g',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: 'claude',
      runtime_driver: 'native-macos',
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    },
    containerName: 'fixture',
    mounts: [],
    containerConfig: {
      provider: 'claude',
      additionalMounts: [],
      packages: { apt: [], npm: [] },
      skills: [],
      mcpServers: {
        plugin: { command: './serve', pluginRoot: '/workspace/agent/plugins/example', cwd: '${PLUGIN_ROOT}' },
      },
    },
    contribution: { env: {} },
    gateway: {
      nativeProxy: { http: 'http://127.0.0.1:1', https: 'http://127.0.0.1:1' },
      env: {},
      networkAccess: { endpoint: '127.0.0.1', target: { kind: 'host' } },
    },
    mailboxEnvironment: {},
  };
}
async function run(spec: SessionSpec, program: string) {
  const driver = new NativeSessionDriver(async () => false);
  spec.native!.command = [process.execPath, '-e', program];
  const result = path.join(spec.native!.env.TMPDIR, 'result');
  const handle = await driver.prepare(spec);
  try {
    await handle.start();
    await expect.poll(() => fs.existsSync(result), { timeout: 10_000 }).toBe(true);
    return fs.readFileSync(result, 'utf8');
  } catch (error) {
    throw new Error(
      String(error) + '\n' + fs.readFileSync(path.join(nativePaths(spec.key.sessionId).root, 'runner.log'), 'utf8'),
      { cause: error },
    );
  } finally {
    await handle.stop('home-fixture-finished');
  }
}
describe.skipIf(process.platform !== 'darwin' || process.env.NANOCLAW_NATIVE_PROVIDER_SMOKE !== '1')(
  'native composition with installed tools',
  () => {
    it('supports native image conversion and zsh heredocs while keeping host writes denied', async () => {
      const request = input();
      const spec = await composeNativeSession(request, []);
      const program = String.raw`
        const fs=require('fs'),cp=require('child_process'),path=require('path');
        const bmp=Buffer.alloc(58);bmp.write('BM');bmp.writeUInt32LE(58,2);bmp.writeUInt32LE(54,10);
        bmp.writeUInt32LE(40,14);bmp.writeInt32LE(1,18);bmp.writeInt32LE(1,22);
        bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp[56]=255;
        const source=path.join(process.env.TMPDIR,'pixel.bmp'),target=path.join(process.env.TMPDIR,'pixel.png');
        fs.writeFileSync(source,bmp);
        const image=cp.spawnSync('/usr/bin/sips',['-s','format','png',source,'--out',target],{encoding:'utf8'});
        const shell=cp.spawnSync('/bin/zsh',['-c','cat <<EOF\n'+ 'x'.repeat(20000)+'\nEOF'],{encoding:'utf8'});
        const host=cp.spawnSync(process.execPath,['-e','require("fs").writeFileSync(${JSON.stringify(path.join(fixture.data, "outside"))},"bad")']);
        fs.writeFileSync(process.env.TMPDIR+'/result',JSON.stringify({image:image.status,imageError:image.stderr,png:fs.existsSync(target),shell:shell.status,shellError:shell.stderr,length:shell.stdout.length,host:host.status}));
      `;
      const result = JSON.parse(await run(spec, program));
      expect(result).toMatchObject({image: 0, png: true, shell: 0, length: 20001});
      expect(result.host).not.toBe(0);
    }, 30_000);
    it('refuses a HOME symlink instead of granting its external target', async () => {
      fs.symlinkSync(fixture.data, path.join(fixture.groups, 'agent/.home'));
      await expect(composeNativeSession(input(), [])).rejects.toThrow('real directory');
    });
    it('initializes gateway files inside Seatbelt and refuses a symlink redirect', async () => {
      const source = path.join(fixture.data, 'stub');
      fs.writeFileSync(source, 'public-stub');
      const target = path.join(nativeAgentHome('agent'), '.config/example/stub');
      const request = input();
      request.gateway.nativeFiles = [{ source, target }];
      request.gateway.nativeReadonly = [source];
      const spec = await composeNativeSession(request, []);
      expect(fs.existsSync(target)).toBe(false);
      expect(
        await run(
          spec,
          `const fs=require('fs');fs.writeFileSync(process.env.TMPDIR+'/result',fs.readFileSync(${JSON.stringify(target)},'utf8'));`,
        ),
      ).toBe('public-stub');
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);

      const victim = path.join(fixture.data, 'host-only');
      fs.writeFileSync(victim, 'unchanged');
      fs.unlinkSync(target);
      fs.symlinkSync(victim, target);
      const next = input();
      next.gateway = request.gateway;
      const redirected = await composeNativeSession(next, []);
      const handle = await new NativeSessionDriver(async () => false).prepare(redirected);
      try {
        await handle.start();
        await expect.poll(async () => (await handle.status()).phase, { timeout: 5_000 }).toBe('failed');
        expect(fs.readFileSync(victim, 'utf8')).toBe('unchanged');
      } finally {
        await handle.stop('redirect-fixture-finished');
      }
    }, 20_000);
    it('shares a persistent writable HOME across sessions while retaining session and agent boundaries', async () => {
      const first = input();
      first.containerConfig.mcpServers.home = {
        command: '/home/node/bin/example',
        cwd: '/home/node',
        env: { CONFIG: '/home/node/.config/example' },
      };
      const a = await composeNativeSession(first, []);
      const second = input();
      second.session.agent_provider = 'opencode';
      const b = await composeNativeSession(second, []);
      const other = input();
      other.agentGroup = { ...other.agentGroup, id: 'other', folder: 'other' };
      other.session.agent_group_id = 'other';
      fs.mkdirSync(path.join(fixture.groups, 'other'));
      fs.writeFileSync(path.join(fixture.groups, 'other/instructions.runtime.md'), 'Other agent');
      const c = await composeNativeSession(other, []);
      const home = nativeAgentHome('agent');
      expect(home).toBe(path.join(fixture.groups, 'agent/.home'));
      expect(a.native!.env.HOME).toBe(home);
      expect(b.native!.env.HOME).toBe(home);
      expect(c.native!.env.HOME).not.toBe(home);
      expect(a.native!.env.TMPDIR).not.toBe(b.native!.env.TMPDIR);
      expect(a.native!.stateDirectory).not.toBe(b.native!.stateDirectory);
      expect(a.native!.env.XDG_CONFIG_HOME).toBe(b.native!.env.XDG_CONFIG_HOME);
      expect(a.native!.env.XDG_CACHE_HOME).toBe(b.native!.env.XDG_CACHE_HOME);
      expect(a.native!.env.XDG_DATA_HOME).toBe(b.native!.env.XDG_DATA_HOME);
      for (const spec of [a, b]) {
        expect(spec.native!.writeRoots).toContain(home);
        expect(spec.native!.denyWrite.some((p) => home === p || home.startsWith(p + '/'))).toBe(false);
        expect(fs.existsSync(path.join(nativePaths(spec.key.sessionId).root, 'home'))).toBe(false);
      }
      const layout = JSON.parse(a.native!.env.NANOCLAW_RUNNER_LAYOUT);
      const config = JSON.parse(fs.readFileSync(layout.config, 'utf8'));
      expect(config.mcpServers.home).toMatchObject({
        command: path.join(home, 'bin/example'),
        cwd: home,
        env: { CONFIG: path.join(home, '.config/example') },
      });

      // Use the actual composed Seatbelt profiles, rather than only checking paths.
      const file = path.join(home, '.gitconfig');
      expect(
        await run(
          a,
          `const fs=require('fs'),cp=require('child_process');cp.execFileSync('/usr/bin/git',['config','--global','user.name','Shared Agent']);fs.writeFileSync(process.env.HOME+'/.zshrc','# agent configuration\\n');fs.mkdirSync(process.env.HOME+'/.claude',{recursive:true});fs.writeFileSync(process.env.HOME+'/.claude/settings.json','{}');for(const name of ['CLAUDE.md','AGENTS.md','container.json'])fs.writeFileSync(name,'agent-owned');fs.mkdirSync('plugins',{recursive:true});fs.writeFileSync('plugins/example','agent-owned');fs.writeFileSync(process.env.TMPDIR+'/result','saved');`,
        ),
      ).toBe('saved');
      expect(
        await run(
          b,
          `const fs=require('fs');let denied=false;try{fs.writeFileSync(${JSON.stringify(path.join(c.native!.env.HOME, 'foreign'))},'bad')}catch(e){denied=['EPERM','EACCES'].includes(e.code)}fs.writeFileSync(process.env.TMPDIR+'/result',JSON.stringify({config:require('child_process').execFileSync('/usr/bin/git',['config','--global','user.name'],{encoding:'utf8'}).trim(),denied}));`,
        ),
      ).toBe(JSON.stringify({ config: 'Shared Agent', denied: true }));
      expect(fs.readFileSync(file, 'utf8')).toContain('Shared Agent');
      expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf8')).toContain('agent configuration');
      expect(fs.existsSync(path.join(c.native!.env.HOME, 'foreign'))).toBe(false);
      for (const name of ['CLAUDE.md', 'AGENTS.md', 'container.json', 'plugins/example'])
        expect(fs.readFileSync(path.join(a.native!.cwd, name), 'utf8')).toBe('agent-owned');
    }, 30_000);
    it('enforces explicit operator denies inside the group and protects runtime controls', async () => {
      const home = nativeAgentHome('agent');
      const blocked = path.join(home, 'blocked');
      const policy = structuredClone(DEFAULT_EXECUTION_POLICY);
      policy.filesystem.denyWrite = [blocked];
      await new ExecutionStore(getDb()).put('agent', 'g', policy, 0);
      const spec = await composeNativeSession(input(), []);
      const layout = JSON.parse(spec.native!.env.NANOCLAW_RUNNER_LAYOUT);
      const configBefore = fs.readFileSync(layout.config, 'utf8');
      const files = [blocked, layout.config, path.join(spec.native!.stateDirectory, 'foreign')];
      const results = await run(
        spec,
        `const fs=require('fs');const results=${JSON.stringify(files)}.map(file=>{try{fs.writeFileSync(file,'bad');return 'allowed'}catch(e){return e.code}});fs.writeFileSync(process.env.TMPDIR+'/result',JSON.stringify(results));`,
      );
      for (const result of JSON.parse(results)) expect(result).toMatch(/EPERM|EACCES/);
      expect(fs.existsSync(blocked)).toBe(false);
      expect(fs.readFileSync(layout.config, 'utf8')).toBe(configBefore);
    }, 30_000);
    it('uses real plugin paths and protects generated runtime configuration', async () => {
      const spec = await composeNativeSession(input(), []);
      expect(spec.containers).toEqual([]);
      const layout = JSON.parse(spec.native!.env.NANOCLAW_RUNNER_LAYOUT);
      const config = JSON.parse(fs.readFileSync(layout.config, 'utf8'));
      expect(config.mcpServers.plugin.pluginRoot).toBe(path.join(fixture.groups, 'agent/plugins/example'));
      expect(spec.native!.denyWrite).not.toContain(path.join(spec.native!.env.HOME, '.claude/settings.json'));
      expect(spec.native!.denyWrite).toContain(layout.config);
      expect(spec.native!.denyRead).toContain(spec.native!.stateDirectory);
    });
    it('refuses host control write grants even when an ancestor is granted', async () => {
      const p = structuredClone(DEFAULT_EXECUTION_POLICY);
      p.filesystem.allowWrite = [path.dirname(process.cwd())];
      await new ExecutionStore(getDb()).put('agent', 'g', p, 0);
      await expect(composeNativeSession(input(), [])).rejects.toThrow('host control state');
    });
    it('refuses Docker package declarations rather than silently omitting dependencies', async () => {
      const spec = input();
      spec.containerConfig.packages.apt = ['curl'];
      await expect(composeNativeSession(spec, [])).rejects.toThrow('Docker package lists');
    });
  },
);

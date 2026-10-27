import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../mailbox/sqlite/schema.js';
import { NativeSessionDriver } from '../drivers/native-driver.js';
import { DEFAULT_EXECUTION_POLICY } from './policy.js';
import type { SessionSpec } from '../drivers/types.js';

const source = path.resolve('container/agent-runner/src');
const executable = (name: string) =>
  name === 'opencode'
    ? fs.realpathSync(path.resolve(`node_modules/opencode-darwin-${process.arch}/bin/opencode`))
    : execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe.skipIf(process.platform !== 'darwin' || process.env.NANOCLAW_NATIVE_PROVIDER_SMOKE !== '1')(
  'native installed providers with local model transport',
  () => {
    it.each(['claude', 'opencode'].filter(provider => fs.existsSync(path.join(source, 'providers', provider + '.ts'))))(
      'runs %s through the real runner and session mailboxes',
      async (provider) => {
        fs.mkdirSync('.cache', { recursive: true });
        const root = fs.realpathSync(fs.mkdtempSync(path.resolve('.cache/native-runner-')));
        const group = path.join(root, 'agent'),
          session = path.join(root, 'session'),
          home = path.join(root, 'home'),
          control = path.join(root, 'control');
        for (const dir of [group, session, home, control]) fs.mkdirSync(dir, { mode: 0o700 });
        const requests: string[] = [];
        const bodies: any[] = [];
        const respond = async (req: http.IncomingMessage, res: http.ServerResponse) => {
          requests.push(req.url || '');
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const input = raw ? JSON.parse(raw) : {};
          if (req.url?.includes('count_tokens')) {
            res.setHeader('Content-Type', 'application/json');
            res.end('{"input_tokens":10}');
            return;
          }
          if (req.url?.includes('/messages')) bodies.push(input);
          if (!req.url?.includes('/messages')) {
            res.writeHead(404);
            res.end('{}');
            return;
          }
          const message = {
            id: 'msg-native-fixture',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: '<message to="Operator">native-smoke-ok</message>' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          };
          if (!input.stream) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(message));
            return;
          }
          res.setHeader('Content-Type', 'text/event-stream');
          const event = (name: string, value: unknown) =>
            res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
          event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
          event('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          });
          event('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '<message to="Operator">native-smoke-ok</message>' },
          });
          event('content_block_stop', { type: 'content_block_stop', index: 0 });
          event('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 5 },
          });
          event('message_stop', { type: 'message_stop' });
          res.end();
        };
        const api = http.createServer((req, res) => {
          void respond(req, res).catch((error) =>
            res.destroy(error instanceof Error ? error : new Error(String(error))),
          );
        });
        await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
        const modelPort = (api.address() as net.AddressInfo).port,
          providerPort = await freePort();
        const inbound = new Database(path.join(session, 'inbound.db'));
        inbound.exec(INBOUND_SCHEMA);
        inbound.pragma('journal_mode = DELETE');
        inbound
          .prepare('INSERT INTO session_routing(id,channel_type,platform_id) VALUES(1,?,?)')
          .run('workspace', 'fixture');
        inbound
          .prepare('INSERT INTO messages_in(id,seq,kind,timestamp,content) VALUES(?,?,?,?,?)')
          .run(
            'smoke-input',
            2,
            'chat',
            new Date().toISOString(),
            JSON.stringify({ text: 'Reply with native-smoke-ok', sender: 'Operator', senderId: 'fixture' }),
          );
        inbound
          .prepare('INSERT INTO destinations(name,display_name,type,channel_type,platform_id) VALUES(?,?,?,?,?)')
          .run('Operator', 'Operator', 'channel', 'workspace', 'fixture');
        const outbound = new Database(path.join(session, 'outbound.db'));
        outbound.exec(OUTBOUND_SCHEMA);
        const config = path.join(root, 'runner.json'),
          context = path.join(root, 'context.json'),
          instructions = path.join(root, 'instructions.md');
        fs.writeFileSync(instructions, 'RUNTIME_CONTRACT_PROOF. You are a test fixture. Answer the message.');
        fs.writeFileSync(path.join(group, 'instructions.prepend.md'), 'IDENTITY_CREED_PROOF');
        fs.writeFileSync(path.join(group, 'CLAUDE.md'), 'You are a test fixture.');
        fs.writeFileSync(
          config,
          JSON.stringify({
            provider,
            assistantName: 'Fixture',
            agentGroupId: 'g',
            groupName: 'Fixture',
            model: provider === 'claude' ? 'claude-sonnet-4-6' : 'anthropic/claude-sonnet-4-6',
            mcpServers: {},
          }),
        );
        fs.writeFileSync(context, JSON.stringify({ agentGroupId: 'g', sessionId: 's', mailbox: null }));
        const policy = structuredClone(DEFAULT_EXECUTION_POLICY);
        policy.network.unknown = 'deny';
        const layout = {
          kind: 'native',
          agent: group,
          session,
          source,
          config,
          context,
          instructions,
          additionalDirectories: [],
          executables: { bun: executable('bun'), [provider]: executable(provider) },
          executionPolicy: policy,
        };
        const env = {
          PATH: process.env.PATH!,
          HOME: home,
          TMPDIR: home,
          XDG_DATA_HOME: path.join(home, '.local/share'),
          XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_CACHE_HOME: path.join(home, '.cache'),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(home, '.cache/bun'),
          NANOCLAW_RUNNER_LAYOUT: JSON.stringify(layout),
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
          ANTHROPIC_API_KEY: 'fixture-not-a-real-key',
          OPENCODE_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
          OPENCODE_PROVIDER: 'anthropic',
          OPENCODE_MODEL: 'claude-sonnet-4-6',
          NANOCLAW_PROVIDER_PORT: String(providerPort),
          OPENCODE_SERVER_PASSWORD: 'fixture-password',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_AUTOUPDATER: '1',
          DO_NOT_TRACK: '1',
        };
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
            command: [executable('bun'), 'run', '--no-env-file', path.join(source, 'index.ts')],
            cwd: group,
            env,
            policy,
            readRoots: [root, source],
            writeRoots: [group, session, home],
            denyRead: [control],
            denyWrite: [config, context, instructions, path.join(session, 'inbound.db')],
            internalPorts: [modelPort, providerPort],
            unixSockets: [home],
            parentProxy: { http: 'http://127.0.0.1:1', https: 'http://127.0.0.1:1' },
            stateDirectory: control,
          },
        };
        const handle = await new NativeSessionDriver(async () => false).prepare(spec);
        try {
          await handle.start();
          const deadline = Date.now() + 35_000;
          let text = '';
          while (Date.now() < deadline) {
            const rows = outbound.prepare('SELECT content FROM messages_out').all() as { content: string }[];
            text = rows.map((r) => r.content).join('\n');
            if (text.includes('native-smoke-ok')) break;
            if ((await handle.status()).phase === 'failed') throw new Error('Native runner exited');
            await new Promise((r) => setTimeout(r, 100));
          }
          expect(text).toContain('native-smoke-ok');
          const request = bodies.find(body => JSON.stringify(body).includes('IDENTITY_CREED_PROOF'));
          expect(request).toBeTruthy();
          expect(JSON.stringify(request).match(/IDENTITY_CREED_PROOF/g)).toHaveLength(1);
          expect(JSON.stringify(request).match(/RUNTIME_CONTRACT_PROOF/g)).toHaveLength(1);
          expect(requests.some((p) => p.includes('/messages'))).toBe(true);
          expect(fs.existsSync(path.join(group, 'memory/index.md'))).toBe(true);
          fs.writeFileSync(path.join(group, 'instructions.prepend.md'), 'IDENTITY_UPDATED_PROOF');
          fs.writeFileSync(path.join(group, 'memory/index.md'), 'MEMORY_UPDATED_PROOF');
          inbound.prepare('INSERT INTO messages_in(id,seq,kind,timestamp,content) VALUES(?,?,?,?,?)').run('followup',4,'chat',new Date().toISOString(),JSON.stringify({text:'Reply again',sender:'Operator',senderId:'fixture'}));
          const followupDeadline = Date.now() + 15000;
          while (!bodies.some(body => JSON.stringify(body).includes('IDENTITY_UPDATED_PROOF')) && Date.now() < followupDeadline) await new Promise(r => setTimeout(r,100));
          const followup = bodies.find(body => JSON.stringify(body).includes('IDENTITY_UPDATED_PROOF'));
          expect(followup).toBeTruthy();
          expect(JSON.stringify(followup).match(/IDENTITY_UPDATED_PROOF/g)).toHaveLength(1);
          expect(JSON.stringify(followup)).toContain('MEMORY_UPDATED_PROOF');

        } catch (error) {
          throw new Error(
            String(error) +
              '\n' +
              fs.readFileSync(path.join(root, 'runner.log'), 'utf8') +
              '\n' +
              (fs.existsSync(path.join(home, '.local/share/opencode/startup.log'))
                ? fs.readFileSync(path.join(home, '.local/share/opencode/startup.log'), 'utf8')
                : ''),
            { cause: error },
          );
        } finally {
          await handle.stop('fixture-done');
          inbound.close();
          outbound.close();
          await new Promise<void>((r) => api.close(() => r()));
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
      50_000,
    );
  },
);

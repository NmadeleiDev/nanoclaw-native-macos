import { beforeEach, afterEach, it, expect } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createSession } from '../db/sessions.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { ExecutionStore } from './store.js';
import { DEFAULT_EXECUTION_POLICY } from './policy.js';
import { guard } from '../guard/index.js';
import { browserConnectionGuard } from './browser-action.js';
import { browserPaths, browserStatus, reserveHostBrowserPort, stopHostBrowser, ensureHostBrowser } from './browser.js';
beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'g',
    name: 'Browser fixture',
    folder: 'browser-fixture',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('g', 'claude');
  await getDb().run("UPDATE container_configs SET cli_scope='disabled' WHERE agent_group_id='g'");
  await createSession({
    id: 's',
    agent_group_id: 'g',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
    runtime_driver: 'native-macos',
  });
});
afterEach(async () => {
  await stopHostBrowser('g');
  await closeDb();
});
const actor = { kind: 'agent' as const, agentGroupId: 'g', sessionId: 's' };
it('rejects browser requests without a grant before creating a browser', async () => {
  expect((await guard(browserConnectionGuard, { actor, payload: {} })).effect).toBe('deny');
  await expect(ensureHostBrowser('g')).rejects.toThrow('disabled');
  expect((await browserStatus('g')).phase).toBe('stopped');
});
it('uses trusted session identity and ignores forged payload identity', async () => {
  const p = structuredClone(DEFAULT_EXECUTION_POLICY);
  p.browser.hostChrome = true;
  await new ExecutionStore(getDb()).put('agent', 'g', p, 0);
  expect((await guard(browserConnectionGuard, { actor, payload: { agentId: 'someone-else' } })).effect).toBe('allow');
  expect(
    (await guard(browserConnectionGuard, { actor: { ...actor, agentGroupId: 'other' }, payload: {} })).effect,
  ).toBe('deny');
  await getDb().run("UPDATE sessions SET runtime_driver='docker' WHERE id='s'");
  expect((await guard(browserConnectionGuard, { actor, payload: {} })).effect).toBe('deny');
});
it('reserves one stable port concurrently without requiring Chrome, and rechecks revocation', async () => {
  const p = structuredClone(DEFAULT_EXECUTION_POLICY);
  p.browser.hostChrome = true;
  await new ExecutionStore(getDb()).put('agent', 'g', p, 0);
  const values = await Promise.all(Array.from({ length: 8 }, () => reserveHostBrowserPort('g')));
  expect(new Set(values).size).toBe(1);
  expect((await browserStatus('g')).phase).toBe('stopped');
  p.browser.hostChrome = false;
  await new ExecutionStore(getDb()).put('agent', 'g', p, 1);
  await expect(reserveHostBrowserPort('g')).rejects.toThrow('disabled');
});
it('keeps agent profiles separate and respects live tool denies', async () => {
  expect(browserPaths('g').profile).not.toBe(browserPaths('other').profile);
  expect(browserPaths('../../g').root).toContain('native-browser/');
  const p = structuredClone(DEFAULT_EXECUTION_POLICY);
  p.browser.hostChrome = true;
  p.tools.deny = ['mcp:nanoclaw:native_browser_connection'];
  await new ExecutionStore(getDb()).put('agent', 'g', p, 0);
  expect((await guard(browserConnectionGuard, { actor, payload: {} })).effect).toBe('deny');
});

it('exposes browser status to the host CLI and rejects agent attempts to open it through operator commands', async () => {
  await import('../cli/resources/execution.js');
  const { dispatch } = await import('../cli/dispatch.js');
  expect(
    await dispatch({ id: 'status', command: 'groups-browser-status', args: { id: 'g' } }, { caller: 'host' }),
  ).toMatchObject({ ok: true, data: { enabled: false, phase: 'stopped' } });
  expect(
    await dispatch(
      { id: 'open', command: 'groups-browser-open', args: { id: 'g' } },
      { caller: 'agent', agentGroupId: 'g', sessionId: 's', messagingGroupId: '' },
    ),
  ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
});

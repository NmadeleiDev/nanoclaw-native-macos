import { beforeEach, afterEach, it, expect } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { createSession, getSession } from '../db/sessions.js';
import { ExecutionStore } from './store.js';
import { DEFAULT_EXECUTION_POLICY } from './policy.js';
import { executionSettings, updateExecutionSettings } from './service.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'g',
    folder: 'native-test',
    name: 'Native test',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('g', 'claude');
});
afterEach(closeDb);
it('snapshots agent defaults and lets an unused session change backend', async () => {
  await updateExecutionSettings('agent', 'g', { runtimeDriver: 'native-macos' });
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
  });
  await updateExecutionSettings('agent', 'g', { runtimeDriver: 'docker' });
  expect((await getSession('s'))?.runtime_driver).toBe('native-macos');
  expect((await executionSettings('session', 's')).runtimeMutable).toBe(true);
  await updateExecutionSettings('session', 's', { runtimeDriver: 'docker' });
  expect((await getSession('s'))?.runtime_driver).toBe('docker');
});
it('does not partially save runtime changes when policy validation or revision checks fail', async () => {
  await expect(
    updateExecutionSettings('agent', 'g', { runtimeDriver: 'native-macos', policy: {}, revision: 0 }),
  ).rejects.toThrow();
  expect((await executionSettings('agent', 'g')).runtimeDriver).toBe('docker');
  await updateExecutionSettings('agent', 'g', { policy: DEFAULT_EXECUTION_POLICY, revision: 0 });
  await expect(
    updateExecutionSettings('agent', 'g', {
      runtimeDriver: 'native-macos',
      policy: DEFAULT_EXECUTION_POLICY,
      revision: 0,
    }),
  ).rejects.toThrow('changed');
  expect((await executionSettings('agent', 'g')).runtimeDriver).toBe('docker');
});
it('requires separate explicit authorization for Docker authority', async () => {
  const policy = structuredClone(DEFAULT_EXECUTION_POLICY);
  policy.docker.unrestricted = true;
  await expect(updateExecutionSettings('agent', 'g', { policy, revision: 0 })).rejects.toThrow('explicit confirmation');
  await updateExecutionSettings('agent', 'g', { policy, revision: 0, confirmDocker: true });
  expect((await new ExecutionStore(getDb()).effective('g')).policy.docker.unrestricted).toBe(true);
});

it('keeps host Chrome off for old documents and requires an agent-only explicit grant', async () => {
  const old = JSON.parse(JSON.stringify(DEFAULT_EXECUTION_POLICY));
  delete old.browser;
  await updateExecutionSettings('agent', 'g', { policy: old, revision: 0 });
  expect((await executionSettings('agent', 'g')).effective.policy.browser.hostChrome).toBe(false);
  const p = structuredClone(DEFAULT_EXECUTION_POLICY);
  p.browser.hostChrome = true;
  await expect(updateExecutionSettings('agent', 'g', { policy: p, revision: 1 })).rejects.toThrow(
    'explicit confirmation',
  );
  expect((await executionSettings('agent', 'g')).revision).toBe(1);
  await updateExecutionSettings('agent', 'g', { policy: p, revision: 1, confirmBrowserException: true });
  expect((await executionSettings('agent', 'g')).effective.policy.browser.hostChrome).toBe(true);
  await expect(new ExecutionStore(getDb()).put('session', 's', p, 0)).rejects.toThrow('only be granted on the agent');
  await expect(new ExecutionStore(getDb()).put('install', 'default', p, 0)).rejects.toThrow(
    'only be granted on the agent',
  );
});

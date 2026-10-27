import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { createSession, getSession, recordSessionActivity } from '../db/sessions.js';
import { initSessionFolder, withMailboxSession, writeSessionMessage } from '../session-manager.js';
import { ExecutionStore } from './store.js';
import { DEFAULT_EXECUTION_POLICY } from './policy.js';
import { executionSettings, updateExecutionSettings } from './service.js';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../config.js', async (original) => {
  const actual = await original<typeof import('../config.js')>();
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.resolve('.cache'), { recursive: true });
  fixture.root = fs.mkdtempSync(path.resolve('.cache/conversation-runtime-'));
  return { ...actual, DATA_DIR: fixture.root };
});
beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'g',
    folder: 'fixture',
    name: 'Fixture',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('g', 'claude');
  await createSession({
    id: 's',
    agent_group_id: 'g',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    runtime_driver: 'docker',
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(path.join(fixture.root, 'v2-sessions'), { recursive: true, force: true });
});

afterAll(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

it('changes unused sessions both ways without starting execution', async () => {
  for (const runtimeDriver of ['native-macos', 'docker']) {
    const settings = await updateExecutionSettings('session', 's', { runtimeDriver });
    expect(settings).toMatchObject({ runtimeDriver, runtimeMutable: true });
    expect(await getSession('s')).toMatchObject({ last_active: null, container_status: 'stopped' });
  }
});

it('locks on durable message admission, before any runner starts, and still allows permission saves', async () => {
  await writeSessionMessage('g', 's', {
    id: 'first',
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ text: 'Hello' }),
  });
  expect((await executionSettings('session', 's')).runtimeMutable).toBe(false);
  await expect(updateExecutionSettings('session', 's', { runtimeDriver: 'native-macos' })).rejects.toMatchObject({
    status: 409,
  });
  await updateExecutionSettings('session', 's', {
    runtimeDriver: 'docker',
    policy: DEFAULT_EXECUTION_POLICY,
    revision: 0,
  });
  expect((await getSession('s'))?.runtime_driver).toBe('docker');
});

it('locks legacy history even when its activity stamp is missing', async () => {
  initSessionFolder('g', 's');
  await withMailboxSession('g', 's', (box) =>
    box.insertMessage({
      id: 'legacy',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{}',
      processAfter: null,
      recurrence: null,
      trigger: true,
      sourceSessionId: null,
      onWake: false,
    }),
  );
  expect((await getSession('s'))?.last_active).toBeNull();
  expect((await executionSettings('session', 's')).runtimeMutable).toBe(false);
  await expect(updateExecutionSettings('session', 's', { runtimeDriver: 'native-macos' })).rejects.toMatchObject({
    status: 409,
  });
});

it('locks prior execution claims and inactive sessions', async () => {
  await getDb().run(
    'INSERT INTO session_claims(session_id,incarnation,updated_at) VALUES(?,?,?)',
    's',
    1,
    new Date().toISOString(),
  );
  expect((await executionSettings('session', 's')).runtimeMutable).toBe(false);
  await getDb().run('DELETE FROM session_claims WHERE session_id=?', 's');
  await getDb().run("UPDATE sessions SET status='closed' WHERE id=?", 's');
  expect((await executionSettings('session', 's')).runtimeMutable).toBe(false);
});

it('rejects a backend change when admission wins after the eligibility snapshot, without partially saving its policy', async () => {
  const original = ExecutionStore.prototype.get;
  vi.spyOn(ExecutionStore.prototype, 'get').mockImplementationOnce(async function (this: ExecutionStore, scope, id) {
    await recordSessionActivity('s');
    return original.call(this, scope, id);
  });
  await expect(
    updateExecutionSettings('session', 's', {
      runtimeDriver: 'native-macos',
      policy: DEFAULT_EXECUTION_POLICY,
      revision: 0,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await getSession('s'))?.runtime_driver).toBe('docker');
  expect((await new ExecutionStore(getDb()).get('session', 's')).revision).toBe(0);
});

it('returns the saved backend to execution admission instead of the creator’s stale snapshot', async () => {
  const stale = await getSession('s');
  await updateExecutionSettings('session', 's', { runtimeDriver: 'native-macos' });
  expect(stale?.runtime_driver).toBe('docker');
  expect((await recordSessionActivity('s'))?.runtime_driver).toBe('native-macos');
  await expect(updateExecutionSettings('session', 's', { runtimeDriver: 'docker' })).rejects.toMatchObject({
    status: 409,
  });
});

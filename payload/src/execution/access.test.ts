import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createSession, createPendingApproval } from '../db/sessions.js';
import { getResponseHandlers, type ResponsePayload } from '../response-registry.js';
import { ExecutionStore } from './store.js';
import { DEFAULT_EXECUTION_POLICY } from './policy.js';
import { requestNetworkAccess } from './access.js';

vi.mock('../modules/approvals/primitive.js', async () => {
  const actual = await vi.importActual<typeof import('../modules/approvals/primitive.js')>(
    '../modules/approvals/primitive.js',
  );
  return {
    ...actual,
    requestApproval: vi.fn(async (o: import('../modules/approvals/primitive.js').RequestApprovalOptions) =>
      createPendingApproval({
        approval_id: o.requestId!,
        title: o.title,
        question: o.question,
        options_json: JSON.stringify(o.options),
        request_id: o.requestId!,
        session_id: o.session.id,
        action: o.action,
        payload: JSON.stringify(o.payload),
        created_at: new Date().toISOString(),
        expires_at: o.expiresAt,
        approver_user_id: 'test:owner',
      }),
    ),
  };
});
const key = { installSlug: 'fixture', agentGroupId: 'g', sessionId: 's' };
beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'g',
    folder: 'access-test',
    name: 'Test',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
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
afterEach(closeDb);
async function pending() {
  for (let i = 0; i < 100; i++) {
    const row = await getDb().get<{ approval_id: string }>('SELECT approval_id FROM pending_approvals');
    if (row) return row.approval_id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('No approval');
}
async function click(questionId: string, value: string, userId = 'owner') {
  const response: ResponsePayload = {
    questionId,
    value,
    userId,
    channelType: 'test',
    platformId: 'dm',
    threadId: null,
  };
  for (const handler of getResponseHandlers()) if (await handler(response)) return;
  throw new Error('Approval was not handled');
}
it('rejects forged session ownership and explicit denies without prompting', async () => {
  expect(await requestNetworkAccess({ ...key, agentGroupId: 'other' }, 'example.com', 443)).toBe(false);
  const p = structuredClone(DEFAULT_EXECUTION_POLICY);
  p.network.deny = ['example.com'];
  await new ExecutionStore(getDb()).put('agent', 'g', p, 0);
  expect(await requestNetworkAccess(key, 'example.com', 443)).toBe(false);
  expect(await getDb().get('SELECT * FROM pending_approvals')).toBeUndefined();
});
it('requires the designated operator and persists only a session-scoped grant', async () => {
  const result = requestNetworkAccess(key, 'example.com', 443);
  const id = await pending();
  await click(id, 'session', 'stranger');
  expect(await getDb().get('SELECT * FROM execution_grants')).toBeUndefined();
  await click(id, 'session');
  expect(await result).toBe(true);
  expect(await requestNetworkAccess(key, 'example.com', 443)).toBe(true);
  expect((await new ExecutionStore(getDb()).get('agent', 'g')).revision).toBe(0);
});
it('expires approvals and rechecks policy before accepting a click', async () => {
  let result = requestNetworkAccess(key, 'example.com', 443);
  let id = await pending();
  await getDb().run('UPDATE pending_approvals SET expires_at=? WHERE approval_id=?', new Date(0).toISOString(), id);
  await click(id, 'agent');
  expect(await result).toBe(false);
  result = requestNetworkAccess(key, 'example.com', 443);
  id = await pending();
  const p = structuredClone(DEFAULT_EXECUTION_POLICY);
  p.network.deny = ['example.com'];
  await new ExecutionStore(getDb()).put('agent', 'g', p, 0);
  await click(id, 'agent');
  expect(await result).toBe(false);
  expect(await getDb().get('SELECT * FROM execution_grants')).toBeUndefined();
});
it('one-connection approvals do not persist and parent denies override existing grants', async () => {
  let result = requestNetworkAccess(key, 'example.com', 443);
  let id = await pending();
  await click(id, 'connection');
  expect(await result).toBe(true);
  expect(await getDb().get('SELECT * FROM execution_grants')).toBeUndefined();
  result = requestNetworkAccess(key, 'example.com', 443);
  id = await pending();
  await click(id, 'session');
  expect(await result).toBe(true);
  const p = structuredClone(DEFAULT_EXECUTION_POLICY);
  p.network.deny = ['example.com'];
  await new ExecutionStore(getDb()).put('agent', 'g', p, 0);
  expect(await requestNetworkAccess(key, 'example.com', 443)).toBe(false);
});

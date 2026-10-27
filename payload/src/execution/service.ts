import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { reconfigureSession, stageExecutionChanges } from './transitions.js';
import { getDb } from '../db/connection.js';
import { getSession } from '../db/sessions.js';
import type { Session } from '../types.js';
import { agentRuntime, validateRuntime } from './runtime.js';
import { ExecutionStore } from './store.js';
import { getSessionDriver, listSessionDriverKinds } from '../drivers/index.js';
import { parseExecutionPolicy } from './policy.js';
import { nativePaths } from './compose.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class ExecutionSettingsError extends Error {
  readonly status = 409;
}

async function sessionRuntimeMutable(session: Session): Promise<boolean> {
  if (session.status !== 'active' || session.last_active !== null || session.container_status !== 'stopped')
    return false;
  const claim = await getDb().get<{ incarnation: number }>(
    'SELECT incarnation FROM session_claims WHERE session_id=?',
    session.id,
  );
  if (claim && claim.incarnation > 0) return false;
  const { withExistingMailboxSession } = await import('../session-manager.js');
  // Existing history also locks legacy sessions whose activity stamp was never written.
  // An absent mailbox is empty; an installed mailbox without history support fails closed.
  const empty = await withExistingMailboxSession(session.agent_group_id, session.id, (box) =>
    box.getWorkspaceInbound ? box.getWorkspaceInbound(0, 1).length === 0 : false,
  );
  return empty !== false;
}

export async function executionSettings(scope: 'agent' | 'session', id: string) {
  const db = getDb();
  const session = scope === 'session' ? await getSession(id) : undefined;
  const agentId = session?.agent_group_id || id;
  if (scope === 'session' && !session) throw new Error('Session not found');
  if (!(await db.get('SELECT id FROM agent_groups WHERE id=?', agentId))) throw new Error('Agent not found');
  const store = new ExecutionStore(db);
  const runtimeDriver = session?.runtime_driver || (await agentRuntime(db, agentId));
  let runtimeLog: string | undefined;
  if (session && runtimeDriver === 'native-macos') {
    const file = path.join(nativePaths(id).root, 'runner.log');
    // Logs are deliberately not included: broad host reads may make them contain credentials.
    if (existsSync(file)) runtimeLog = file;
  }
  const effective = await store.effective(agentId, session?.id);
  let applied: unknown = null;
  if (session && runtimeDriver === 'native-macos') {
    const file = path.join(nativePaths(id).control, 'applied-policy.json');
    if (fs.existsSync(file)) applied = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return {
    savedRevision: createHash('sha256').update(JSON.stringify(effective.policy)).digest('hex'),
    applied,
    transition: session ? await db.get('SELECT id,state,context,error,updated_at FROM execution_transitions WHERE session_id=?', session.id) : null,
    scope,
    id,
    agentId,
    runtimeDriver,
    runtimeMutable: session ? await sessionRuntimeMutable(session) : true,
    ...(await store.get(scope, id)),
    effective,
    runtimeLog,
  };
}
export async function updateExecutionSettings(
  scope: 'agent' | 'session',
  id: string,
  input: {
    runtimeDriver?: unknown;
    policy?: unknown;
    revision?: unknown;
    confirmDocker?: unknown;
    confirmBrowserException?: unknown;
  },
) {
  const old = await executionSettings(scope, id);
  const driver = input.runtimeDriver === undefined ? undefined : validateRuntime(input.runtimeDriver);
  if (scope === 'session' && driver && driver !== old.runtimeDriver && !old.runtimeMutable)
    throw new ExecutionSettingsError('This session’s runtime is fixed after its first message or execution.');
  const policy = input.policy === undefined ? undefined : parseExecutionPolicy(input.policy);
  if (scope === 'session' && policy?.docker.unrestricted)
    throw new Error('Docker daemon authority must be granted persistently on the agent');
  if (policy?.docker.unrestricted && !old.policy.docker.unrestricted && input.confirmDocker !== true)
    throw new Error('Docker daemon access bypasses the sandbox; explicit confirmation is required');
  if (policy?.browser.hostChrome && scope !== 'agent') throw new Error('Host Chrome can only be granted on the agent');
  if (policy?.browser.hostChrome && !old.policy.browser.hostChrome && input.confirmBrowserException !== true)
    throw new Error('Host Chrome runs outside the agent sandbox; explicit confirmation is required');
  await getDb().transaction(async () => {
    if (policy) {
      const affected = scope === 'session' && driver && driver !== 'native-macos' ? [] : scope === 'session' ? await getDb().all<{id:string}>("SELECT id FROM sessions WHERE id=? AND runtime_driver='native-macos'", id) : await getDb().all<{id:string}>("SELECT id FROM sessions WHERE agent_group_id=? AND status='active' AND runtime_driver='native-macos'", id);
      await stageExecutionChanges(getDb(), affected.map(s => s.id));
    }
    if (scope === 'session' && driver && driver !== old.runtimeDriver) {
      const result = await getDb().run(
        `UPDATE sessions SET runtime_driver=? WHERE id=? AND status='active'
         AND last_active IS NULL AND container_status='stopped'
         AND NOT EXISTS (SELECT 1 FROM session_claims WHERE session_id=? AND incarnation>0)`,
        driver,
        id,
        id,
      );
      if (!result.changes)
        throw new ExecutionSettingsError('This session’s runtime is fixed after its first message or execution.');
    }
    if (policy) await new ExecutionStore(getDb()).put(scope, id, policy, input.revision as number);
    if (scope === 'agent' && driver) {
      const result = await getDb().run(
        'UPDATE container_configs SET runtime_driver=?,updated_at=? WHERE agent_group_id=?',
        driver,
        new Date().toISOString(),
        id,
      );
      if (!result.changes) throw new Error('Agent configuration is missing');
    }
  });
  if (policy && scope === 'agent' && !policy.browser.hostChrome)
    await (await import('./browser.js')).stopHostBrowser(id);
  if (policy) {
    const sessions =
      scope === 'session'
        ? [await getSession(id)]
        : await getDb().all<import('../types.js').Session>(
            "SELECT * FROM sessions WHERE agent_group_id=? AND status='active'",
            id,
          );
    for (const session of sessions) if (session?.runtime_driver === 'native-macos') await restartForPolicy(session.id);
  }
  return executionSettings(scope, id);
}

export const restartForPolicy = reconfigureSession;

export async function runtimeDoctor() {
  const out = [];
  for (const kind of listSessionDriverKinds()) {
    try {
      const driver = getSessionDriver(kind);
      await driver.ensureReady?.();
      out.push({ kind, ready: true, capabilities: driver.capabilities() });
    } catch (error) {
      out.push({ kind, ready: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

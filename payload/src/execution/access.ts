import fs from 'node:fs';
import { parseAccessRequest } from './requests.js';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { getSession, deletePendingApproval, transitionPendingApprovalStatus } from '../db/sessions.js';
import { registerResponseHandler } from '../response-registry.js';
import { isAuthorizedApprovalClick } from '../modules/approvals/response-handler.js';
import { requestApproval } from '../modules/approvals/primitive.js';
import { ExecutionStore } from './store.js';
import { networkDecision } from './policy.js';
import type { SessionKey } from '../drivers/types.js';
import type { PendingApproval } from '../types.js';

const waiting = new Map<string, { resolve: (allow: boolean) => void; promise: Promise<boolean> }>();

/** Called by a trusted supervisor handle, never using model-supplied session identity. */
export async function requestNetworkAccess(key: SessionKey, host: string, port: number): Promise<boolean> {
  const session = await getSession(key.sessionId);
  if (
    !session ||
    session.status !== 'active' ||
    session.agent_group_id !== key.agentGroupId ||
    session.runtime_driver !== 'native-macos'
  )
    return false;
  const store = new ExecutionStore(getDb());
  const policy = (await store.effective(key.agentGroupId, key.sessionId)).policy;
  const decision = networkDecision(policy, host, port);
  if (decision !== 'ask') return decision === 'allow';
  const destination = `${host.toLowerCase()}:${port}`;
  const grant = await getDb().get(
    'SELECT id FROM execution_grants WHERE session_id=? AND destination=?',
    session.id,
    destination,
  );
  if (grant) return true;
  const id = `native-network-${session.id}-${destination}`;
  const previous = waiting.get(id);
  if (previous) return previous.promise;
  if ([...waiting.keys()].filter((k) => k.startsWith(`native-network-${session.id}-`)).length >= 20) return false;
  let settle!: (allow: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  waiting.set(id, { resolve: settle, promise });
  const requestId = `native-${randomUUID()}`;
  const timer = setTimeout(() => settle(false), 120_000);
  try {
    await requestApproval({
      session,
      agentName: key.agentGroupId,
      action: 'native_network_access',
      payload: { id, destination },
      requestId,
      title: 'Allow network access?',
      question: `Native agent requests ${destination}. This grants a connection, not credentials or every API action.`,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      options: [
        { label: 'This connection', value: 'connection' },
        { label: 'This session', value: 'session' },
        { label: 'This agent', value: 'agent' },
        { label: 'Deny', value: 'deny' },
      ],
    });
    if (!(await getDb().get('SELECT approval_id FROM pending_approvals WHERE approval_id=?', requestId))) return false;
    return await promise;
  } finally {
    clearTimeout(timer);
    waiting.delete(id);
    await deletePendingApproval(requestId);
  }
}

registerResponseHandler(
  async (response) => {
    const approval = await getDb().get<PendingApproval>(
      'SELECT * FROM pending_approvals WHERE approval_id=?',
      response.questionId,
    );
    if (!approval || !['native_network_access', 'native_access_request'].includes(approval.action)) return false;
    if (!(await isAuthorizedApprovalClick(approval, response))) return true;
    if (approval.action === 'native_access_request') {
      if (!approval.session_id || !approval.expires_at || Date.parse(approval.expires_at) <= Date.now()) {
        await deletePendingApproval(approval.approval_id);
        return true;
      }
      if (!['session', 'agent', 'deny'].includes(response.value)) return true;
      const session = await getSession(approval.session_id);
      if (!session || session.status !== 'active' || session.runtime_driver !== 'native-macos') return true;
      if (
        !(await transitionPendingApprovalStatus(
          approval.approval_id,
          'pending',
          response.value === 'deny' ? 'rejected' : 'approved',
        ))
      )
        return true;
      try {
        if (response.value !== 'deny') {
          const request = parseAccessRequest(JSON.parse(approval.payload).request);
          if (
            (request.kind === 'read' || request.kind === 'write') &&
            fs.realpathSync(request.target) !== request.target
          )
            throw new Error('The requested path changed; request access again');
          if (request.kind === 'docker' && response.value !== 'agent')
            throw new Error('Docker authority requires an agent grant');
          const scope = response.value === 'agent' ? 'agent' : 'session';
          const id = scope === 'agent' ? session.agent_group_id : session.id;
          const store = new ExecutionStore(getDb());
          const doc = await store.get(scope, id);
          if (request.kind === 'read') doc.policy.filesystem.allowRead.push(request.target);
          if (request.kind === 'write') doc.policy.filesystem.allowWrite.push(request.target);
          if (request.kind === 'listen') doc.policy.network.listenPorts.push(+request.target);
          if (request.kind === 'local-connect') doc.policy.network.localConnectPorts.push(+request.target);
          if (request.kind === 'docker') doc.policy.docker.unrestricted = true;
          await (
            await import('./service.js')
          ).updateExecutionSettings(scope, id, {
            policy: doc.policy,
            revision: doc.revision,
            confirmDocker: request.kind === 'docker',
          });
        }
      } finally {
        await deletePendingApproval(approval.approval_id);
      }
      return true;
    }
    const payload = JSON.parse(approval.payload) as { id: string; destination: string };
    const waiter = waiting.get(payload.id);
    if (!waiter || !approval.expires_at || Date.parse(approval.expires_at) <= Date.now()) {
      waiter?.resolve(false);
      await deletePendingApproval(approval.approval_id);
      return true;
    }
    if (!['connection', 'session', 'agent', 'deny'].includes(response.value)) return true;
    if (
      !(await transitionPendingApprovalStatus(
        approval.approval_id,
        'pending',
        response.value === 'deny' ? 'rejected' : 'approved',
      ))
    )
      return true;
    const session = approval.session_id ? await getSession(approval.session_id) : undefined;
    if (!session || session.status !== 'active') {
      waiter.resolve(false);
      return true;
    }
    const store = new ExecutionStore(getDb());
    const effective = (await store.effective(session.agent_group_id, session.id)).policy;
    if (networkDecision(effective, ...splitDestination(payload.destination)) === 'deny') {
      waiter.resolve(false);
      return true;
    }
    if (response.value === 'session')
      await getDb().run(
        'INSERT INTO execution_grants(id,session_id,destination,scope,created_at) VALUES(?,?,?,?,?)',
        randomUUID(),
        session.id,
        payload.destination,
        'session',
        new Date().toISOString(),
      );
    if (response.value === 'agent') {
      const doc = await store.get('agent', session.agent_group_id);
      doc.policy.network.allow.push(payload.destination);
      await store.put('agent', session.agent_group_id, doc.policy, doc.revision);
    }
    waiter.resolve(response.value !== 'deny');
    return true;
  },
  { prepend: true },
);

function splitDestination(value: string): [string, number] {
  const i = value.lastIndexOf(':');
  return [value.slice(0, i), +value.slice(i + 1)];
}

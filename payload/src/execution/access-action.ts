import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { registerDeliveryAction } from '../delivery.js';
import { unguarded } from '../guard/index.js';
import { requestApproval } from '../modules/approvals/primitive.js';
import { ExecutionStore } from './store.js';
import { getDb } from '../db/connection.js';
import { parseAccessRequest } from './requests.js';

registerDeliveryAction(
  'execution_access',
  async (input, session) => {
    if (session.runtime_driver !== 'native-macos')
      throw new Error('Native access requests are only available in native sessions');
    const request = parseAccessRequest(input);
    if (request.kind === 'read' || request.kind === 'write') {
      const target = fs.realpathSync(request.target);
      const policy = (await new ExecutionStore(getDb()).effective(session.agent_group_id, session.id)).policy;
      const denies =
        request.kind === 'read'
          ? policy.filesystem.denyRead
          : [...policy.filesystem.denyRead, ...policy.filesystem.denyWrite];
      if (denies.some((d) => target === d || target.startsWith(d + '/')))
        throw new Error('An explicit deny applies; ask the operator to edit that rule');
      request.target = target;
    }
    const count = await getDb().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id=? AND action='native_access_request' AND status='pending'",
      session.id,
    );
    if ((count?.n ?? 0) >= 20) throw new Error('Too many pending access requests');
    await requestApproval({
      session,
      agentName: session.agent_group_id,
      action: 'native_access_request',
      payload: { request },
      requestId: `native-access-${randomUUID()}`,
      title: request.kind === 'docker' ? 'Grant unrestricted Docker authority?' : 'Allow native access?',
      question: `${request.kind}: ${request.target}\n${request.reason}\n${request.kind === 'docker' ? 'Docker acts outside the sandbox.' : 'Applying access restarts native execution without automatically replaying tools.'}`,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      options:
        request.kind === 'docker'
          ? [
              { label: 'Grant for this agent', value: 'agent' },
              { label: 'Deny', value: 'deny' },
            ]
          : [
              { label: 'This session', value: 'session' },
              { label: 'This agent', value: 'agent' },
              { label: 'Deny', value: 'deny' },
            ],
    });
  },
  unguarded('Only submits a bounded, expiring request to an authenticated operator; never grants permissions.'),
);

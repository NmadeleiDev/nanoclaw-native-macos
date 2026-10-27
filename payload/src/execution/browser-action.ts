import { registerDeliveryAction } from '../delivery.js';
import { unguarded, defineGuardedAction, guard, ALLOW, DENY } from '../guard/index.js';
import { getSession } from '../db/sessions.js';
import { ExecutionStore } from './store.js';
import { getDb } from '../db/connection.js';
import { writeSessionMessage } from '../session-manager.js';
import { onHostShutdown } from '../host-lifecycle.js';
import { browserConnection, stopAllHostBrowsers } from './browser.js';
import { toolAllowed } from './policy.js';
export const browserConnectionGuard = defineGuardedAction({
  action: 'execution.browser.connect',
  async decide({ actor }) {
    if (actor.kind !== 'agent' || !actor.sessionId) return DENY('An agent session is required');
    const session = await getSession(actor.sessionId);
    if (
      !session ||
      session.agent_group_id !== actor.agentGroupId ||
      session.runtime_driver !== 'native-macos' ||
      session.status !== 'active'
    )
      return DENY('An active native session owned by this agent is required');
    const store = new ExecutionStore(getDb());
    if (!(await store.get('agent', actor.agentGroupId)).policy.browser.hostChrome)
      return DENY('Host Chrome is disabled. Enable the browser exception in Agent execution settings.');
    if (
      !toolAllowed(
        (await store.effective(actor.agentGroupId, actor.sessionId)).policy,
        'mcp:nanoclaw:native_browser_connection',
      )
    )
      return DENY('Browser connection denied by tool policy');
    return ALLOW('Operator granted this agent the host Chrome exception');
  },
});
registerDeliveryAction(
  'native_browser_connection',
  async (input, session) => {
    const requestId = input.requestId;
    if (typeof requestId !== 'string' || !/^browser-[a-zA-Z0-9-]{1,80}$/.test(requestId))
      throw new Error('Invalid browser request identifier');
    let frame;
    try {
      const decision = await guard(browserConnectionGuard, {
        actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
        payload: {},
      });
      if (decision.effect !== 'allow') throw new Error(decision.reason);
      frame = { id: requestId, ok: true, data: await browserConnection(session.id) };
    } catch (error) {
      frame = {
        id: requestId,
        ok: false,
        error: { code: 'browser-unavailable', message: error instanceof Error ? error.message : String(error) },
      };
    }
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `browser-response-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ type: 'cli_response', requestId, frame }),
      trigger: false,
    });
  },
  unguarded('Inline request/reply transport; execution.browser.connect is guarded inside, including error responses.'),
);

onHostShutdown(stopAllHostBrowsers);

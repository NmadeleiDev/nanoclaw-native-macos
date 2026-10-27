import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { getSession } from '../db/sessions.js';
import { nativePaths } from './compose.js';
import { onHostStart } from '../host-lifecycle.js';

export async function stageExecutionChanges(db: import('../db/driver.js').DbDriver, sessionIds: string[]) {
  for (const id of sessionIds) {
    const old = await db.get<{state:string}>('SELECT state FROM execution_transitions WHERE session_id=?', id);
    if (old && old.state !== 'complete') continue;
    await db.run(`INSERT INTO execution_transitions(session_id,id,state,context,updated_at) VALUES (?,?,'pending',?,?)
      ON CONFLICT(session_id) DO UPDATE SET id=excluded.id,state=excluded.state,context=excluded.context,error=NULL,updated_at=excluded.updated_at`,
      id, randomUUID(), JSON.stringify({ interruptedMessageIds: [] }), new Date().toISOString());
  }
}
const active = new Map<string, Promise<void>>();
export function reconfigureSession(id: string): Promise<void> {
  const existing = active.get(id);
  if (existing) return existing;
  const promise = run(id).finally(() => active.delete(id));
  active.set(id, promise);
  return promise;
}
async function run(id: string) {
  const db = getDb(), session = await getSession(id);
  if (!session || session.runtime_driver !== 'native-macos') return;
  const { isContainerRunning, killContainer, beginAgentConfiguration } = await import('../container-runner.js');
  const { withMailboxSession, writeSessionMessage } = await import('../session-manager.js');
  const pause = beginAgentConfiguration(session.agent_group_id);
  if (!pause) throw new Error('Another settings change is in progress for this agent');
  try {
    await pause.settle([id]);
    let row = await db.get<{id:string; state:string; context:string}>('SELECT * FROM execution_transitions WHERE session_id=?', id);
    if (!row || row.state === 'complete') {
      const claims = await withMailboxSession(session.agent_group_id, id, box => box.getProcessingClaims().map(c => c.messageId));
      row = { id: randomUUID(), state: 'pending', context: JSON.stringify({ interruptedMessageIds: claims, continuation: session.id, operationStatus: claims.length ? 'unknown; inspect before repeating' : 'idle' }) };
      await db.run(`INSERT INTO execution_transitions(session_id,id,state,context,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET id=excluded.id,state=excluded.state,context=excluded.context,error=NULL,updated_at=excluded.updated_at`,
        id, row.id, row.state, row.context, new Date().toISOString());
    }
    const context = JSON.parse(row.context) as { interruptedMessageIds: string[]; workspace?: unknown };
    const { sessionWorkspaceContext } = await import('../session-workspace.js');
    const workspace = await sessionWorkspaceContext(id);
    if (workspace) context.workspace = JSON.parse(workspace);
    await withMailboxSession(session.agent_group_id, id, box => {
      box.setWorkspaceControl?.(JSON.stringify({ kind: 'cancel', at: new Date().toISOString() }));
      // Include anything claimed between the initial checkpoint and cancellation.
      for (const claim of box.getProcessingClaims()) if (!context.interruptedMessageIds.includes(claim.messageId)) context.interruptedMessageIds.push(claim.messageId);
      for (const messageId of context.interruptedMessageIds) box.markMessageFailed(messageId);
    });
    await db.run('UPDATE execution_transitions SET context=?,updated_at=? WHERE session_id=?', JSON.stringify(context), new Date().toISOString(), id);
    if (isContainerRunning(id)) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Policy saved; cleanup is not verified. This conversation remains blocked.')), 20_000);
      killContainer(id, 'execution-policy-changed', () => { clearTimeout(timeout); resolve(); });
    });
    if (fs.existsSync(path.join(nativePaths(id).control, 'lease.json'))) throw new Error('Previous native process lease remains; cleanup must be verified before resuming');
    if (context.interruptedMessageIds.length) await writeSessionMessage(session.agent_group_id, id, {
      id: `execution-${row.id}`, kind: 'chat', timestamp: new Date().toISOString(), onWake: true,
      content: JSON.stringify({ sender: 'system', senderId: 'system', text: `Execution permissions changed. Resume the existing task using its conversation history and scratchpad. Interrupted message IDs: ${context.interruptedMessageIds.join(', ')}. A tool may have completed before interruption: inspect files and recorded results before repeating any side effect.` }),
    });
    await withMailboxSession(session.agent_group_id, id, box => box.setWorkspaceControl?.('{}'));
    await db.run("UPDATE execution_transitions SET state='complete',error=NULL,updated_at=? WHERE session_id=?", new Date().toISOString(), id);
    if (context.interruptedMessageIds.length) {
      const { requestWake } = await import('../request-wake.js');
      // Release below replays this deferred wake under the current policy.
      await requestWake(session, 'inbound-message');
    }
  } catch (error) {
    await db.run('UPDATE execution_transitions SET error=?,updated_at=? WHERE session_id=?', String(error), new Date().toISOString(), id);
    throw error;
  } finally { pause.release(); }
}
onHostStart(async () => {
  const rows = await getDb().all<{session_id:string}>("SELECT session_id FROM execution_transitions WHERE state!='complete'");
  for (const row of rows) {
    try { await reconfigureSession(row.session_id); }
    catch (error) { console.error('Execution remains blocked:', row.session_id, String(error)); }
  }
});

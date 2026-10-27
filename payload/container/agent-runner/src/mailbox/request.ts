import type { AgentMailbox } from './types.js';
export type HostReply<T = unknown> =
  | { id: string; ok: true; data: T; human?: string }
  | { id: string; ok: false; error: { code: string; message: string } };
/** Existing inline mailbox response envelope, shared by ncl and native browser tools. */
export async function requestHost<T>(
  mailbox: AgentMailbox,
  requestId: string,
  action: string,
  payload: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<HostReply<T> | null> {
  await mailbox.run(() =>
    mailbox.operations.writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ ...payload, action, requestId }),
    }),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await mailbox.run(() => {
      const row = mailbox.operations.findCliResponse(requestId);
      if (!row) return null;
      mailbox.operations.markMessages([row.id], 'completed');
      return (JSON.parse(row.content) as { frame: HostReply<T> }).frame;
    });
    if (response) return response;
    await Bun.sleep(100);
  }
  return null;
}

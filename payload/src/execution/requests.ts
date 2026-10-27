export interface AccessRequest {
  kind: 'read' | 'write' | 'local-connect' | 'listen' | 'docker';
  target: string;
  reason: string;
}
export function parseAccessRequest(raw: Record<string, unknown>): AccessRequest {
  if (!['read', 'write', 'local-connect', 'listen', 'docker'].includes(raw.kind as string))
    throw new Error('Invalid native access kind');
  if (typeof raw.target !== 'string' || !raw.target || raw.target.length > 4096 || /[\0\r\n]/.test(raw.target))
    throw new Error('Invalid access target');
  const kind = raw.kind as AccessRequest['kind'];
  if ((kind === 'read' || kind === 'write') && (!raw.target.startsWith('/') || raw.target.split('/').includes('..')))
    throw new Error('Access paths must be absolute');
  if (
    (kind === 'local-connect' || kind === 'listen') &&
    (!/^\d+$/.test(raw.target) || +raw.target < 1024 || +raw.target > 65535)
  )
    throw new Error('Choose a port between 1024 and 65535');
  if (kind === 'docker' && raw.target !== 'local-daemon')
    throw new Error('Only the local Docker daemon can be granted');
  if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 500)
    throw new Error('Explain the access request in at most 500 characters');
  return { kind, target: raw.target, reason: raw.reason.trim() };
}

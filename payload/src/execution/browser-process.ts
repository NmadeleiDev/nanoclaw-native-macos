import { spawnSync } from 'node:child_process';
/** Host-only browser launch contract. Never supplied by an agent. */
export interface BrowserLaunch {
  executable: string;
  profile: string;
  temporary: string;
  control: string;
  port: number;
  environment: Record<string, string>;
}
export type BrowserMessage = { type: 'ready'; pid: number } | { type: 'failure'; message: string };
export async function browserCommand(
  endpoint: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10000,
) {
  const version = (await fetch(endpoint + '/json/version', {
    redirect: 'error',
    signal: AbortSignal.timeout(2000),
  }).then((r) => {
    if (!r.ok) throw new Error('Browser discovery failed');
    return r.json();
  })) as { webSocketDebuggerUrl?: string };
  const ws = version.webSocketDebuggerUrl ? new URL(version.webSocketDebuggerUrl) : undefined;
  if (
    !ws ||
    ws.protocol !== 'ws:' ||
    ws.hostname !== '127.0.0.1' ||
    ws.port !== new URL(endpoint).port ||
    !ws.pathname.startsWith('/devtools/browser/')
  )
    throw new Error('Unexpected browser endpoint');
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(version.webSocketDebuggerUrl!);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Browser command timed out: ${method}`));
    }, timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    };
    socket.addEventListener('error', () => fail(new Error('Browser control connection failed')));
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      reject(new Error('Browser control connection closed'));
    });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (message.error) {
          fail(new Error(message.error.message));
          return;
        }
        clearTimeout(timer);
        resolve(message.result ?? {});
        socket.close();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export function browserOwnsPort(pid: number, port: number) {
  const result = spawnSync(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(pid), `-i4TCP@127.0.0.1:${port}`, '-sTCP:LISTEN'],
    {
      encoding: 'utf8',
      timeout: 1000,
    },
  );
  return result.status === 0;
}

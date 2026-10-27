import http from 'node:http';
import { it, expect } from 'vitest';
import { browserCommand, browserOwnsPort } from './browser-process.js';
it('rejects discovery that points browser control at another port', async () => {
  const server = http.createServer((_, res) =>
    res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/foreign' })),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await expect(browserCommand(`http://127.0.0.1:${port}`, 'Browser.close')).rejects.toThrow(
      'Unexpected browser endpoint',
    );
    if (process.platform === 'darwin') {
      expect(browserOwnsPort(process.pid, port)).toBe(true);
      expect(browserOwnsPort(process.ppid, port)).toBe(false);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

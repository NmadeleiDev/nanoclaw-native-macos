/** Connection-only helper. Chrome is exclusively launched by the trusted host. */
import './modules/index.js';
import { spawn } from 'node:child_process';
import { runtimeLayout, runtimeToolAllowed } from './runtime-layout.js';
import { getAgentMailbox, readMailboxContext } from './mailbox/index.js';
import { requestHost } from './mailbox/request.js';
async function main() {
  const layout = runtimeLayout();
  if (layout.kind !== 'native') throw new Error('Native browser helper requires a native session');
  if (!layout.executionPolicy?.browser?.hostChrome)
    throw new Error('Host Chrome is disabled. Enable the browser exception in Agent execution settings.');
  if (!runtimeToolAllowed('mcp:nanoclaw:native_browser_connection'))
    throw new Error('Browser connection denied by tool policy');
  const args = process.argv.slice(2);
  if (
    args[0] === 'connect' ||
    args.some((a) =>
      /^(--cdp|--auto-connect|--profile|--executable-path|--session|--namespace|--no-pin-tab)(=|$)/.test(a),
    )
  )
    throw new Error(
      'Native browser connection, profile, and session are selected by NanoClaw; use browsing commands directly.',
    );
  const browser = layout.executables['agent-browser'];
  if (!browser) throw new Error('Native execution needs agent-browser on the host PATH');
  const box = getAgentMailbox();
  await box.start(await readMailboxContext());
  let connection: { endpoint: string; port: number; browserSession: string };
  try {
    const result = await requestHost<typeof connection>(
      box,
      `browser-${crypto.randomUUID()}`,
      'native_browser_connection',
      {},
    );
    if (!result) throw new Error('Host browser connection timed out');
    if (!result.ok) throw new Error(result.error.message);
    connection = result.data;
  } finally {
    await box.stop();
  }
  const endpoint = new URL(connection.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
    throw new Error('Invalid host browser endpoint');
  const child = spawn(browser, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENT_BROWSER_CDP: connection.endpoint,
      AGENT_BROWSER_SESSION: connection.browserSession,
      AGENT_BROWSER_AUTO_CONNECT: '0',
      AGENT_BROWSER_PIN_TAB: '1',
    },
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

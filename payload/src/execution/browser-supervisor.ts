/** A sibling of the Seatbelt runner, retaining Chrome's own renderer sandbox. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { OwnedProcessTree } from './owned-processes.js';
import { browserCommand, browserOwnsPort } from './browser-process.js';
import type { BrowserLaunch } from './browser-process.js';
let config: BrowserLaunch | undefined,
  tree: OwnedProcessTree | undefined,
  chrome: ChildProcess | undefined,
  stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (config && chrome?.pid && chrome.exitCode === null && browserOwnsPort(chrome.pid, config.port)) {
    try {
      await browserCommand(`http://127.0.0.1:${config.port}`, 'Browser.close', {}, 2000);
    } catch (error) {
      console.error('Browser graceful close unavailable:', error instanceof Error ? error.message : String(error));
    }
  }
  if (chrome?.pid && chrome.exitCode === null)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      chrome!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  await tree?.stop(2000);
  if (config) fs.rmSync(path.join(config.control, 'lease.json'), { force: true });
  process.exit(code);
}
function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.connected) process.send?.({ type: 'failure', message });
  if (stopping) process.exit(1);
  else void stop(1).catch(() => process.exit(1));
}
async function main() {
  if (process.platform !== 'darwin' || !process.send) throw new Error('Host Chrome requires a macOS supervisor');
  config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const c = config!;
  tree = new OwnedProcessTree(c.control);
  process.on('message', (m) => {
    if ((m as { type?: unknown })?.type === 'stop') void stop().catch(fail);
  });
  process.on('disconnect', () => void stop().catch(fail));
  process.on('SIGTERM', () => void stop().catch(fail));
  process.on('SIGINT', () => void stop().catch(fail));
  for (const dir of [c.profile, c.temporary, path.join(c.profile, 'downloads'), path.join(c.profile, 'crashes')])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const preferences = path.join(c.profile, 'Default/Preferences');
  if (!fs.existsSync(preferences)) {
    fs.mkdirSync(path.dirname(preferences), { recursive: true });
    fs.writeFileSync(
      preferences,
      JSON.stringify({ download: { default_directory: path.join(c.profile, 'downloads') } }),
      { mode: 0o600 },
    );
  }
  const args = [
    `--user-data-dir=${c.profile}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${c.port}`,
    `--crash-dumps-dir=${path.join(c.profile, 'crashes')}`,
    '--enable-automation',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    'about:blank',
  ];
  chrome = spawn(c.executable, args, {
    env: {
      ...c.environment,
      TMPDIR: c.temporary,
      MAC_CHROMIUM_TMPDIR: c.temporary,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  chrome.on('error', fail);
  chrome.on('exit', (code) => {
    if (!stopping) {
      if (code !== 0 && process.connected) process.send?.({ type: 'failure', message: `Host Chrome exited (${code})` });
      void stop(code ?? 1).catch(fail);
    }
  });
  const timer = setInterval(async () => {
    try {
      await tree!.track();
    } catch (error) {
      fail(error);
    }
  }, 250);
  timer.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (stopping) return;
    await tree.track();
    if (chrome.pid) {
      if (browserOwnsPort(chrome.pid, c.port)) {
        try {
          const response = await fetch(`http://127.0.0.1:${c.port}/json/version`, { signal: AbortSignal.timeout(500) });
          if (response.ok) {
            if (process.connected) process.send!({ type: 'ready', pid: chrome.pid });
            return;
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Host Chrome did not become ready on its owned port; inspect browser.log');
}
void main().catch(fail);

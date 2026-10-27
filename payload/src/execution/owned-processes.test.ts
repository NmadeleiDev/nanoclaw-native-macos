import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) =>
        execFile(...args, (error: unknown, stdout: string, stderr: string) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        ),
      ),
  });
  return { execFile };
});
vi.mock('node:child_process', () => mocked);
import { OwnedProcessTree } from './owned-processes.js';
afterEach(() => vi.resetAllMocks());
it('retries transient inspection failure without losing supervision', async () => {
  const root = fs.mkdtempSync(path.resolve('.cache/ownership-'));
  try {
    mocked.execFile
      .mockImplementationOnce((_file, _args, _options, cb) => cb(new Error('process disappeared')))
      .mockImplementation((_file, _args, _options, cb) => cb(null, `${process.pid} 1 test-stamp`, ''));
    await new OwnedProcessTree(root).track();
    expect(mocked.execFile).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'process.json'), 'utf8')).supervisor).toBe(process.pid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('bounds failed inspections and preserves the actual failure details', async () => {
  mocked.execFile.mockImplementation((_file, _args, _options, cb) =>
    cb(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', signal: 'SIGTERM', stderr: 'diagnostic' })),
  );
  await expect(new OwnedProcessTree('.cache').track()).rejects.toThrow(
    'code=ETIMEDOUT; signal=SIGTERM; stderr=diagnostic',
  );
  expect(mocked.execFile).toHaveBeenCalledTimes(3);
});
it('coalesces concurrent scans without blocking the event loop', async () => {
  const root = fs.mkdtempSync(path.resolve('.cache/ownership-'));
  try {
    mocked.execFile.mockImplementation((_file, _args, _options, cb) =>
      setTimeout(() => cb(null, `${process.pid} 1 stamp`, ''), 50),
    );
    const tree = new OwnedProcessTree(root);
    const first = tree.track();
    const second = tree.track();
    expect(first).toBe(second);
    let timer = false;
    setTimeout(() => {
      timer = true;
    }, 5);
    await first;
    expect(timer).toBe(true);
    expect(mocked.execFile).toHaveBeenCalledTimes(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

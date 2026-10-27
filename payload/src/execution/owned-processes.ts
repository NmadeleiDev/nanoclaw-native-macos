/** Best-effort descendant accounting, shared by trusted native supervisors. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import fs from 'node:fs';
import path from 'node:path';
async function processTable() {
  let stdout = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      ({ stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 4 * 1024 * 1024,
      }));
      break;
    } catch (error) {
      if (attempt === 3) {
        const failure = error as Error & { code?: unknown; signal?: string; stderr?: string };
        throw new Error(
          `Could not inspect native process ownership after 3 attempts: ${failure.message}; code=${failure.code}; signal=${failure.signal}; stderr=${failure.stderr || '(empty)'}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return new Map(
    stdout
      .trim()
      .split('\n')
      .flatMap((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        return m ? [[+m[1], { parent: +m[2], stamp: m[3] }] as const] : [];
      }),
  );
}
export class OwnedProcessTree {
  private descendants = new Map<number, string>();
  constructor(private readonly stateDirectory: string) {}
  private tracking?: Promise<void>;
  track(): Promise<void> {
    return (this.tracking ??= this.snapshot().finally(() => {
      this.tracking = undefined;
    }));
  }
  private async snapshot() {
    const table = await processTable();
    for (const [pid, stamp] of this.descendants) if (table.get(pid)?.stamp !== stamp) this.descendants.delete(pid);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [pid, entry] of table)
        if (
          pid !== process.pid &&
          this.descendants.get(pid) !== entry.stamp &&
          (entry.parent === process.pid ||
            (this.descendants.has(entry.parent) &&
              table.get(entry.parent)?.stamp === this.descendants.get(entry.parent)))
        ) {
          this.descendants.set(pid, entry.stamp);
          changed = true;
        }
    }
    fs.writeFileSync(
      path.join(this.stateDirectory, 'process.json'),
      JSON.stringify({
        supervisor: process.pid,
        supervisorStamp: table.get(process.pid)?.stamp,
        processes: [...this.descendants].map(([pid, stamp]) => ({ pid, stamp })),
        updatedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  }
  async stop(graceMs = 500) {
    await this.track();
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const table = await processTable();
      const alive = [...this.descendants].filter(([pid, stamp]) => table.get(pid)?.stamp === stamp);
      if (!alive.length) break;
      for (const [pid, stamp] of alive)
        if (table.get(pid)?.stamp === stamp) {
          try {
            process.kill(pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      await new Promise((r) => setTimeout(r, signal === 'SIGTERM' ? graceMs : 100));
      await this.track();
    }
    const table = await processTable();
    const survivors = [...this.descendants].filter(([pid, stamp]) => table.get(pid)?.stamp === stamp);
    if (survivors.length)
      throw new Error(
        `Native cleanup incomplete; surviving task processes: ${survivors.map(([pid]) => pid).join(', ')}`,
      );
  }
}
